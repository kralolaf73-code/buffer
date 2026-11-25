import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.join(root, "health.json");
const outputPath = path.join(root, "streams", "links.json");

if (!fs.existsSync(reportPath)) {
  throw new Error("health.json yok; önce update.js çalıştırılmalı.");
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const streams = (report.streams || [])
  .filter((item) => item.valid === true && typeof item.url === "string" && /^https:\/\//i.test(item.url))
  .map(({ name, url }) => ({ name, url }));

if (!report.success || streams.length === 0) {
  throw new Error(`Geçerli yayın bulunamadı. update.js hata: ${report.error || "bilinmiyor"}`);
}

const payload = {
  schemaVersion: 1,
  updatedAt: new Date(report.timestamp || Date.now()).toISOString(),
  workingDomain: report.workingDomain,
  count: streams.length,
  streams,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`${streams.length} doğrulanmış yayın ${path.relative(root, outputPath)} dosyasına yazıldı.`);
