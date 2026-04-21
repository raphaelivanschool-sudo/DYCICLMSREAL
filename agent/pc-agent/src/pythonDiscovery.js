import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PYTHON_CANDIDATES = ['python', 'python3'];
const DEFAULT_TIMEOUT_MS = 90000;

function runScannerWithBinary(binary, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, {
      cwd: path.join(__dirname, '..'),
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Python scanner timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) {
        return reject(new Error(stderr || `Python scanner exited with code ${code}`));
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (code !== 0 && parsed.ok !== true) {
          return reject(new Error(parsed.details || parsed.error || stderr || 'Scanner failed'));
        }
        resolve(parsed);
      } catch (error) {
        reject(new Error(`Invalid JSON output from scanner: ${error.message}; stderr: ${stderr}`));
      }
    });
  });
}

export async function runPythonDiscovery({ subnet, registryOnly = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const scannerPath = path.join(__dirname, '..', 'python', 'network_scanner.py');
  const registryPath = path.join(__dirname, '..', 'python', 'registry.json');

  const args = [scannerPath, '--registry', registryPath];
  if (subnet) args.push('--subnet', subnet);
  if (registryOnly) args.push('--registry-only');

  let lastError = null;
  for (const binary of PYTHON_CANDIDATES) {
    try {
      return await runScannerWithBinary(binary, args, timeoutMs);
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    error: 'Python runtime unavailable',
    details: lastError?.message || 'Could not run python or python3',
    discovered: [],
    warnings: []
  };
}

