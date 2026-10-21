const fs = require('node:fs');
const path = require('node:path');

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const version = manifest.version;
const tag = process.argv[2];
if (tag !== `v${version}` || pkg.version !== version) {
  throw new Error('Tag, manifest.json and package.json versions must match');
}
const changelog = fs.readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n');
const heading = `## ${version}\n`;
const start = changelog.indexOf(heading);
if (start < 0) throw new Error(`CHANGELOG.md has no entry for ${version}`);
const body = changelog.slice(start + heading.length).split('\n## ')[0].trim();
if (!body) throw new Error('Release notes cannot be empty');
const name = `zotero-livereload-${version}.xpi`;
if (!fs.existsSync(path.join('dist', name))) throw new Error(`Build dist/${name} first`);
const notes = `${body}\n\n安装：下载下方的 **${name}**，在 Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件中选择它。升级后关闭并重新打开 PDF 标签页。\n\n已实机验证 Zotero 10.0.6；其他允许安装的版本尚未实机验证。\n`;
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/release-notes.md', notes);
console.log(`Prepared ${tag}: ${name}`);
