import chalk from "chalk"
import { join, dirname, resolve } from "./path"
import { spawnSafeSync } from "./spawnSafe"
import { PackageManager } from "./detectPackageManager"
import { removeIgnoredFiles } from "./filterFiles"
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  mkdirpSync,
  realpathSync,
  renameSync,
} from "fs-extra"
import { sync as rimraf } from "rimraf"
import { copySync } from "fs-extra"
import { dirSync } from "tmp"
import { getPatchFiles } from "./patchFs"
import {
  getPatchDetailsFromCliString,
  getPackageDetailsFromPatchFilename,
  PackageDetails,
} from "./PackageDetails"
import { resolveRelativeFileDependencies } from "./resolveRelativeFileDependencies"
import { getPackageResolution } from "./getPackageResolution"
import { parsePatchFile } from "./patch/parse"
import { gzipSync } from "zlib"
//import { getPackageVersion } from "./getPackageVersion"
import {
  maybePrintIssueCreationPrompt,
  openIssueCreationLink,
} from "./createIssue"
import { quote as shlexQuote } from "shlex"

const isVerbose = global.patchPackageIsVerbose
const isDebug = global.patchPackageIsDebug

function printNoPackageFoundError(
  packageName: string,
  packageJsonPath: string,
) {
  console.error(
    `No such package ${packageName}

  File not found: ${packageJsonPath}`,
  )
}

export function makePatch({
  packagePathSpecifier,
  appPath,
  packageManager,
  includePaths,
  excludePaths,
  patchDir,
  createIssue,
}: {
  packagePathSpecifier: string
  appPath: string
  packageManager: PackageManager
  includePaths: RegExp
  excludePaths: RegExp
  patchDir: string
  createIssue: boolean
}) {
  const packageDetails = getPatchDetailsFromCliString(packagePathSpecifier)

  if (!packageDetails) {
    console.error("No such package", packagePathSpecifier)
    return
  }
  const appPackageJson = require(join(appPath, "package.json"))
  const packagePath = join(appPath, packageDetails.path)
  const packageJsonPath = join(packagePath, "package.json")

  if (!existsSync(packageJsonPath)) {
    printNoPackageFoundError(packagePathSpecifier, packageJsonPath)
    process.exit(1)
  }

  const tmpRepo = dirSync({
    unsafeCleanup: true,
    prefix: "patch-package.tmpRepo.",
  })

  function cleanup() {
    tmpRepo.removeCallback()
  }

  try {
    // finally: cleanup()

    const tmpRepoPackagePath = join(tmpRepo.name, packageDetails.path)
    const tmpRepoNpmRoot = tmpRepoPackagePath.slice(
      0,
      -`/node_modules/${packageDetails.name}`.length,
    )

    const tmpRepoPackageJsonPath = join(tmpRepoNpmRoot, "package.json")

    const patchesDir = resolve(join(appPath, patchDir))

    console.info(chalk.grey("•"), "Creating temporary folder")

    const resolvedVersion = getPackageResolution({
      packageDetails,
      packageManager,
      appPath,
      appPackageJson,
    })

    // make a blank package.json
    mkdirpSync(tmpRepoNpmRoot)
    writeFileSync(
      tmpRepoPackageJsonPath,
      JSON.stringify({
        dependencies: {
          [packageDetails.name]: resolvedVersion.version,
        },
        resolutions: resolveRelativeFileDependencies(
          appPath,
          appPackageJson.resolutions || {},
        ),
      }),
    )

    /*
    // originCommit is more precise than pkg.version
    if (isDebug) {
      console.log(
        `patch-package/makePatch: resolvedVersion.originCommit = ${resolvedVersion.originCommit}`,
      )
      console.log(
        `patch-package/makePatch: resolvedVersion.version = ${resolvedVersion.version}`,
      )
    }
    const packageVersion =
      resolvedVersion.originCommit ||
      getPackageVersion(join(resolve(packageDetails.path), "package.json"))
    */

    // this is broken when installing from git -> version can be a pseudo-version like 1.0.0-canary
    //const packageVersion = getPackageVersion(join(resolve(packageDetails.path), "package.json"))

    const packageVersion = resolvedVersion.version

    if (isDebug) {
      console.log(`patch-package/makePatch: packageVersion = ${packageVersion}`)
      console.log(
        `patch-package/makePatch: package path = ${packageDetails.path}`,
      )
      console.log(
        `patch-package/makePatch: package path resolved = ${resolve(
          packageDetails.path,
        )}`,
      )
    }

    // copy .npmrc/.yarnrc in case packages are hosted in private registry
    // tslint:disable-next-line:align
    ;[".npmrc", ".yarnrc"].forEach((rcFile) => {
      const rcPath = join(appPath, rcFile)
      if (existsSync(rcPath)) {
        copySync(rcPath, join(tmpRepo.name, rcFile))
      }
    })

    if (packageManager === "yarn") {
      console.info(
        chalk.grey("•"),
        `Installing ${packageDetails.name}@${packageVersion} with yarn`,
      )
      try {
        // try first without ignoring scripts in case they are required
        // this works in 99.99% of cases
        spawnSafeSync(`yarn`, ["install", "--ignore-engines"], {
          cwd: tmpRepoNpmRoot,
          logStdErrOnError: false,
        })
      } catch (e) {
        // try again while ignoring scripts in case the script depends on
        // an implicit context which we havn't reproduced
        spawnSafeSync(
          `yarn`,
          ["install", "--ignore-engines", "--ignore-scripts"],
          {
            cwd: tmpRepoNpmRoot,
          },
        )
      }
    } else {
      const npmCmd = packageManager === "pnpm" ? "pnpm" : "npm"
      console.info(
        chalk.grey("•"),
        `Installing ${packageDetails.name}@${packageVersion} with ${npmCmd}`,
      )
      try {
        // try first without ignoring scripts in case they are required
        // this works in 99.99% of cases
        if (isVerbose) {
          console.log(
            `patch-package/makePatch: run "${npmCmd} install --force" in ${tmpRepoNpmRoot}`,
          )
        }
        spawnSafeSync(npmCmd, ["install", "--force"], {
          cwd: tmpRepoNpmRoot,
          logStdErrOnError: false,
          stdio: isVerbose ? "inherit" : "ignore",
        })
      } catch (e) {
        // try again while ignoring scripts in case the script depends on
        // an implicit context which we havn't reproduced
        if (isVerbose) {
          console.log(
            `patch-package/makePatch: run "${npmCmd} install --ignore-scripts --force" in ${tmpRepoNpmRoot}`,
          )
        }
        spawnSafeSync(npmCmd, ["install", "--ignore-scripts", "--force"], {
          cwd: tmpRepoNpmRoot,
          stdio: isVerbose ? "inherit" : "ignore",
        })
      }
      if (packageManager === "pnpm") {
        // workaround for `git diff`: replace symlink with hardlink
        const pkgPath = tmpRepoNpmRoot + "/node_modules/" + packageDetails.name
        const realPath = realpathSync(pkgPath)
        unlinkSync(pkgPath) // rm symlink
        renameSync(realPath, pkgPath)
      }
    }

    const git = (...args: string[]) =>
      spawnSafeSync("git", args, {
        cwd: tmpRepo.name,
        env: { ...process.env, HOME: tmpRepo.name },
        maxBuffer: 1024 * 1024 * 100,
      })

    // remove nested node_modules just to be safe
    rimraf(join(tmpRepoPackagePath, "node_modules"))
    // remove .git just to be safe
    rimraf(join(tmpRepoPackagePath, ".git"))

    // commit the package
    console.info(chalk.grey("•"), "Diffing your files with clean files")
    writeFileSync(join(tmpRepo.name, ".gitignore"), "!/node_modules\n\n")
    git("init")
    git("config", "--local", "user.name", "patch-package")
    git("config", "--local", "user.email", "patch@pack.age")

    // remove ignored files first
    // use CLI options --exclude and --include
    removeIgnoredFiles(tmpRepoPackagePath, includePaths, excludePaths)

    git("add", "-f", packageDetails.path)
    git("commit", "--allow-empty", "-m", "init")

    // replace package with user's version
    rimraf(tmpRepoPackagePath)

    if (isVerbose) {
      console.log(
        `patch-package/makePatch: copy ${realpathSync(
          packagePath,
        )} to ${tmpRepoPackagePath}`,
      )
    }

    // pnpm installs packages as symlinks, copySync would copy only the symlink
    const srcPath = realpathSync(packagePath)
    copySync(srcPath, tmpRepoPackagePath, {
      filter: (path) => {
        return !path.startsWith(srcPath + "/node_modules/")
      },
    })

    // remove nested node_modules just to be safe
    rimraf(join(tmpRepoPackagePath, "node_modules"))
    // remove .git just to be safe
    rimraf(join(tmpRepoPackagePath, ".git"))

    // also remove ignored files like before
    // use CLI options --exclude and --include
    removeIgnoredFiles(tmpRepoPackagePath, includePaths, excludePaths)

    // stage all files
    git("add", "-f", packageDetails.path)

    const ignorePaths = ["package-lock.json", "pnpm-lock.yaml"]

    // get diff of changes
    const diffResult = git(
      "diff",
      "--cached",
      "--no-color",
      "--ignore-space-at-eol",
      "--no-ext-diff",
      ...ignorePaths.map(
        (path) => `:(exclude,top)${packageDetails.path}/${path}`,
      ),
    )

    if (diffResult.stdout.length === 0) {
      console.warn(
        `⁉️  Not creating patch file for package '${packagePathSpecifier}'`,
      )
      console.warn(`⁉️  There don't appear to be any changes.`)
      cleanup()
      process.exit(1)
      return
    }

    try {
      parsePatchFile(diffResult.stdout.toString())
    } catch (e) {
      if (
        (e as Error).message.includes("Unexpected file mode string: 120000")
      ) {
        console.error(`
⛔️ ${chalk.red.bold("ERROR")}

  Your changes involve creating symlinks. patch-package does not yet support
  symlinks.
  
  ️Please use ${chalk.bold("--include")} and/or ${chalk.bold(
          "--exclude",
        )} to narrow the scope of your patch if
  this was unintentional.
`)
      } else {
        const outPath = "./patch-package-error.json.gz"
        writeFileSync(
          outPath,
          gzipSync(
            JSON.stringify({
              error: { message: e.message, stack: e.stack },
              patch: diffResult.stdout.toString(),
            }),
          ),
        )
        console.error(`
⛔️ ${chalk.red.bold("ERROR")}
        
  patch-package was unable to read the patch-file made by git. This should not
  happen.
  
  A diagnostic file was written to
  
    ${outPath}
  
  Please attach it to a github issue
  
    https://github.com/ds300/patch-package/issues/new?title=New+patch+parse+failed&body=Please+attach+the+diagnostic+file+by+dragging+it+into+here+🙏
  
  Note that this diagnostic file will contain code from the package you were
  attempting to patch.

`)
      }
      cleanup()
      process.exit(1)
      return
    }

    // maybe delete existing
    getPatchFiles(patchDir).forEach((filename) => {
      const deets = getPackageDetailsFromPatchFilename(filename)
      if (deets && deets.path === packageDetails.path) {
        unlinkSync(join(patchDir, filename))
      }
    })

    const patchPackageVersion = require("../package.json").version

    // patchfiles are parsed in patch/parse.ts function parsePatchLines
    // -> header comments are ignored
    let diffHeader = ""
    diffHeader += `# generated by patch-package ${patchPackageVersion} on ${new Date().toLocaleString(
      "lt",
    )}\n`
    diffHeader += `#\n`
    const prettyArgv = process.argv.slice()
    if (prettyArgv[0].match(/node/)) {
      prettyArgv[0] = "npx"
    }
    if (prettyArgv[1].match(/patch-package/)) {
      prettyArgv[1] = "patch-package"
    }
    diffHeader += `# command:\n`
    diffHeader += `#   ${prettyArgv.map((a) => shlexQuote(a)).join(" ")}\n`
    diffHeader += `#\n`
    diffHeader += `# declared package:\n`
    diffHeader += `#   ${packageDetails.name}: ${resolvedVersion.version}\n` // TODO rename to declaredVersion
    if (packageDetails.packageNames.length > 1) {
      diffHeader += `#\n`
      diffHeader += `# package names:\n`
      packageDetails.packageNames.forEach((packageName) => {
        diffHeader += `#   ${packageName}\n`
      })
    }
    diffHeader += `#\n`

    const patchFileName = createPatchFileName({
      packageDetails,
      packageVersion,
    })

    const patchPath = join(patchesDir, patchFileName)
    if (!existsSync(dirname(patchPath))) {
      // scoped package
      mkdirSync(dirname(patchPath))
    }
    writeFileSync(patchPath, diffHeader + diffResult.stdout)
    console.log(
      `${chalk.green("✔")} Created file ${join(patchDir, patchFileName)}\n`,
    )
    if (createIssue) {
      openIssueCreationLink({
        packageDetails,
        patchFileContents: diffResult.stdout.toString(),
        packageVersion,
      })
    } else {
      maybePrintIssueCreationPrompt(packageDetails, packageManager)
    }
  } catch (e) {
    console.error(e)
    throw e
  } finally {
    cleanup()
  }
}

function createPatchFileName({
  packageDetails,
  packageVersion,
}: {
  packageDetails: PackageDetails
  packageVersion: string
}) {
  const packageVersionFilename = packageVersion.includes("#")
    ? packageVersion.split("#")[1] // extract commit hash
    : packageVersion.replace(/\//g, "_")
  if (isVerbose) {
    console.log(
      `patch-package/makePatch: packageVersion ${packageVersion} -> packageVersionFilename ${packageVersionFilename}`,
    )
  }

  const packageNames = packageDetails.packageNames
    .map((name) => name.replace(/\//g, "+"))
    .join("++")

  return `${packageNames}+${packageVersionFilename}.patch`
}
