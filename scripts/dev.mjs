import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// BCV can omit its intermediate CA. These verified certificates apply only locally.
const certificateUrl = new URL('../certs/sectigo-bcv-chain.pem', import.meta.url);
const certificatePath = fileURLToPath(certificateUrl);
const existingCertificatePath = process.env.NODE_EXTRA_CA_CERTS;

let trustedCertificatesPath = certificatePath;
let temporaryDirectory;

if (existingCertificatePath) {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'bcv-local-ca-'));
  trustedCertificatesPath = join(temporaryDirectory, 'combined.pem');

  const existingCertificates = readFileSync(existingCertificatePath, 'utf8');
  const bcvCertificates = readFileSync(certificatePath, 'utf8');
  const combinedCertificates = `${existingCertificates}\n${bcvCertificates}`;

  writeFileSync(trustedCertificatesPath, combinedCertificates);
}

const wranglerUrl = new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url);
const wranglerPath = fileURLToPath(wranglerUrl);
const additionalArguments = process.argv.slice(2);
const wranglerArguments = [wranglerPath, 'dev', ...additionalArguments];
const environment = {
  ...process.env,
  NODE_EXTRA_CA_CERTS: trustedCertificatesPath,
};

const childProcess = spawn(process.execPath, wranglerArguments, {
  stdio: 'inherit',
  env: environment,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    childProcess.kill(signal);
  });
}

childProcess.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

childProcess.on('exit', (exitCode) => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  process.exitCode = exitCode ?? 0;
});
