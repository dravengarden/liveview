const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const zlib = require("zlib");
const tar = require("tar");

const REPO = "USER/lv";
const BIN_NAME = process.platform === "win32" ? "lv.exe" : "lv";

function getPlatformTarget() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux" && arch === "x64") {
    return "x86_64-unknown-linux-gnu";
  } else if (platform === "darwin" && arch === "x64") {
    return "x86_64-apple-darwin";
  } else if (platform === "darwin" && arch === "arm64") {
    return "aarch64-apple-darwin";
  } else if (platform === "win32" && arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }

  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

function getPackageVersion() {
  const pkg = require("./package.json");
  return pkg.version;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Follow redirect
          downloadFile(response.headers.location, dest)
            .then(resolve)
            .catch(reject);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function extractTarGz(src, dest) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(src)
      .pipe(zlib.createGunzip())
      .pipe(
        tar.extract({
          cwd: dest,
        })
      )
      .on("finish", resolve)
      .on("error", reject);
  });
}

async function extractZip(src, dest) {
  execSync(`unzip -o "${src}" -d "${dest}"`, { stdio: "inherit" });
}

async function install() {
  const target = getPlatformTarget();
  const version = getPackageVersion();
  const isWindows = process.platform === "win32";
  const ext = isWindows ? "zip" : "tar.gz";

  const url = `https://github.com/${REPO}/releases/download/v${version}/lv-${target}.${ext}`;
  const binDir = path.join(__dirname, "bin");
  const archivePath = path.join(__dirname, `lv-${target}.${ext}`);

  console.log(`Downloading lv v${version} for ${target}...`);

  // Create bin directory
  if (!fs.existsSync(binDir)) {
    fs.mkdirSync(binDir, { recursive: true });
  }

  try {
    await downloadFile(url, archivePath);

    console.log("Extracting...");
    if (isWindows) {
      await extractZip(archivePath, binDir);
    } else {
      await extractTarGz(archivePath, binDir);
    }

    // Make binary executable
    const binPath = path.join(binDir, BIN_NAME);
    if (!isWindows) {
      fs.chmodSync(binPath, 0o755);
    }

    // Cleanup
    fs.unlinkSync(archivePath);

    console.log("lv installed successfully!");
  } catch (err) {
    console.error("Failed to install lv:", err.message);
    console.error(
      "You may need to install manually from: https://github.com/" + REPO
    );
    process.exit(1);
  }
}

install();
