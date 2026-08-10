import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

if (process.env.SKIP_VERSION_UPDATE === '1') {
  console.log('Skipping version update (running inside release script)');
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const now = new Date();
const year = now.getFullYear();
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');
const hours = String(now.getHours()).padStart(2, '0');
const minutes = String(now.getMinutes()).padStart(2, '0');

const suffix = process.argv[2] ? ` ${process.argv[2]}` : '';
const versionString = `V ${year}.${month}.${day}.${hours}.${minutes}${suffix}`;

const versionPath = path.join(__dirname, 'src', 'version.json');
fs.writeFileSync(versionPath, JSON.stringify({ version: versionString }, null, 2));

console.log(`Updated version to ${versionString}`);
