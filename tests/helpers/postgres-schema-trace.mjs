// Diagnostics for disposable Schema-test containers only. Never reads .env.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function schemaContainerTrace(container) {
  if (!/^ihear-resource-schema-[a-f0-9-]+$/.test(container)) throw new Error('Unexpected schema-test container name');
  const directory = path.resolve('output/postgres-schema-investigation', container);
  mkdirSync(directory, { recursive: true });
  const mark = (phase, detail = {}) => appendFileSync(path.join(directory, 'timeline.jsonl'), JSON.stringify({ at: new Date().toISOString(), phase, ...detail }) + '\n');
  function docker(args, input) {
    const start = new Date().toISOString();
    try {
      const output = execFileSync('docker', args, { input, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 10 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
      mark('docker', { start, args, inputSha256: input ? createHash('sha256').update(input).digest('hex') : null, exitCode: 0, stdout: output });
      return output;
    } catch (error) {
      mark('docker', { start, args, inputSha256: input ? createHash('sha256').update(input).digest('hex') : null, exitCode: error.status, signal: error.signal, stdout: error.stdout?.toString(), stderr: error.stderr?.toString() });
      throw error;
    }
  }
  function capture(label) {
    const raw = docker(['inspect', container]);
    writeFileSync(path.join(directory, `${label}.inspect.json`), raw);
    const [info] = JSON.parse(raw);
    writeFileSync(path.join(directory, `${label}.status.json`), JSON.stringify({ id: info.Id, name: info.Name, state: info.State, health: info.State.Health || 'not configured', restartCount: info.RestartCount, network: info.HostConfig.NetworkMode, ports: info.NetworkSettings.Ports, image: info.Image }, null, 2));
    // Docker logs can use stderr even when successful; retain both streams in full.
    const result = spawnSync('docker', ['logs', '--timestamps', container], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    writeFileSync(path.join(directory, `${label}.postgres.stdout.log`), result.stdout || '');
    writeFileSync(path.join(directory, `${label}.postgres.stderr.log`), result.stderr || '');
    mark('logs-captured', { label, exitCode: result.status });
    if (result.status !== 0) throw new Error('Could not preserve PostgreSQL logs');
  }
  return { directory, docker, mark, capture };
}
