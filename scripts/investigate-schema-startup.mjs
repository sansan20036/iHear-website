// Test-infrastructure investigation only: no environment files, schemas or application imports.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { schemaContainerTrace } from '../tests/helpers/postgres-schema-trace.mjs';

const probe = process.argv.includes('--probe-legacy');
const container = `ihear-resource-schema-${randomUUID()}`;
const trace = schemaContainerTrace(container), { docker } = trace;
const report = { mode: probe ? 'legacy-socket-race-probe' : 'standalone-control', container, schemaStatementsExecuted: 0, migrationStatementsExecuted: 0, status: 'RUNNING' };
let started = false;
try {
  trace.mark('container-start-request', { mode: report.mode });
  docker(['run', '--detach', '--pull=never', '--network', 'none', '--name', container, '--label', 'ihear-test=resource-schema', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine']);
  started = true;
  if (probe) {
    // High-frequency observational probe widens detection coverage, not the
    // container's startup/shutdown window. No init scripts or sleeps injected into PostgreSQL.
    const shell = `
attempt=0
until psql -X -qAt -U postgres -d postgres -c "SELECT clock_timestamp(),pg_postmaster_start_time(),current_setting('listen_addresses')" 2>/dev/null; do
  attempt=$((attempt+1)); [ "$attempt" -lt 1000 ] || exit 20
  sleep 0.01
done
echo LEGACY_SOCKET_READINESS_ACCEPTED
attempt=0
while [ "$attempt" -lt 100 ]; do
  psql -X -qAt -U postgres -d postgres -c "SELECT clock_timestamp(),pg_postmaster_start_time(),current_setting('listen_addresses')" || exit 21
  attempt=$((attempt+1))
  sleep 0.005
done
`;
    try { report.socketProbeOutput = docker(['exec', '-i', container, 'sh', '-s'], shell); report.socketFailure = false; }
    catch (error) { report.socketProbeOutput = error.stdout?.toString(); report.socketProbeError = error.stderr?.toString(); report.socketProbeExit = error.status; report.socketFailure = error.status === 21; }
  }
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const value = docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres'], "SELECT json_build_object('now',clock_timestamp(),'postmasterStart',pg_postmaster_start_time(),'listen',current_setting('listen_addresses'),'address',inet_server_addr(),'port',inet_server_port())");
      report.tcpReady = JSON.parse(value); trace.mark('tcp-readiness-accepted', report.tcpReady); ready = true; break;
    } catch { await new Promise(resolve => { setTimeout(resolve, 250); }); }
  }
  if (!ready) throw new Error('Standalone PostgreSQL TCP startup failed');
  report.stableQueries = [];
  for (let n = 0; n < 5; n++) {
    report.stableQueries.push(docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres'], 'SELECT pg_postmaster_start_time(),1').trim());
    await new Promise(resolve => { setTimeout(resolve, 200); });
  }
  writeFileSync(path.join(trace.directory, 'docker-entrypoint.sh'), docker(['exec', container, 'cat', '/usr/local/bin/docker-entrypoint.sh']));
  report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.failure = error.message; process.exitCode = 1; }
finally {
  if (started) {
    trace.mark('cleanup-enter');
    try { trace.capture('before-cleanup'); }
    finally {
      docker(['stop', '--time', '10', container]);
      try { trace.capture('after-stop'); }
      finally { docker(['rm', '--volumes', container]); trace.mark('cleanup-complete'); }
    }
  }
  writeFileSync(path.join(trace.directory, 'investigation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, artifacts: trace.directory }, null, 2));
}
