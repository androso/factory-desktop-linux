import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const helperPath = path.resolve(new URL('../scripts/install-helper.py', import.meta.url).pathname);

test('root installer accepts only scoped payloads and an unchanged helper', () => {
  const script = `
import stat, sys, types
sys.dont_write_bytecode = True
helper = types.ModuleType("helper_test")
exec(compile(open(${JSON.stringify(helperPath)}, encoding="utf8").read(), ${JSON.stringify(helperPath)}, "exec"), helper.__dict__)
InstallError = helper.InstallError
helper_path = helper.FIXED_HELPER_PATH
trusted = "a" * 64
mode = str(stat.S_IFREG | 0o755)
def entry(filename, digest, caps="(none)", link="(none)"):
    return "\\t".join([filename, mode, digest, caps, link]) + "\\n"
payload = entry("/opt/factory-desktop-linux/factory-desktop", "b" * 64) + entry(helper_path, trusted)
def run_fixed(command, args, **kwargs):
    if "--queryformat" in args:
        return type("Result", (), {"stdout": payload})()
    return type("Result", (), {"stdout": ""})()
helper.run_fixed = run_fixed
helper.validate_rpm_payload("candidate.rpm", trusted)

def rejected(candidate, **kwargs):
    global payload
    payload = candidate
    try:
        helper.validate_rpm_payload("candidate.rpm", trusted, **kwargs)
    except InstallError:
        return
    raise AssertionError("unsafe payload was accepted")

rejected(entry(helper_path, "c" * 64))
rejected(entry("/etc/evil", "b" * 64))
rejected(entry("/opt/factory-desktop-linux/factory-desktop", "b" * 64, caps="cap_net_raw=ep"))
payload = entry("/opt/factory-desktop-linux/factory-desktop", "b" * 64)
helper.validate_rpm_payload("rollback.rpm", trusted, allow_helper_omission=True)

def requirements(command, args, **kwargs):
    if "--requires" in args:
        values = "python3\\nlibc.so.6\\n" if args[0] == "-q" else "python3\\nnew-system-package\\n"
        return type("Result", (), {"stdout": values})()
    return type("Result", (), {"stdout": ""})()
helper.run_fixed = requirements
try:
    helper.validate_candidate_requirements("candidate.rpm")
except InstallError:
    pass
else:
    raise AssertionError("candidate with a new dependency was accepted")
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('DEB updater helper rejects maintainer scripts, unsafe paths, and changed helper bytes', () => {
  const script = `
import hashlib, io, stat, sys, types
sys.dont_write_bytecode = True
module = types.ModuleType("helper_deb_test")
path = ${JSON.stringify(helperPath)}
exec(compile(open(path, encoding="utf8").read(), path, "exec"), module.__dict__)
manifest_bytes = b"build manifest"
metadata = """Package: factory-desktop-linux
Version: 0.194.0-1ubuntu26.04
Architecture: amd64
Depends: python3, util-linux
X-Factory-Build-Manifest-SHA256: PLACEHOLDER
X-Factory-Updater: yes
""".replace("PLACEHOLDER", hashlib.sha256(manifest_bytes).hexdigest())
helper_bytes = b"trusted helper"
trusted = hashlib.sha256(helper_bytes).hexdigest()
module.run_fixed = lambda command, args, **kwargs: type(
    "Result", (), {"stdout": metadata, "returncode": 0, "stderr": ""}
)()

class FakeTar:
    def __init__(self, contents): self.contents = contents
    def extractfile(self, member): return io.BytesIO(self.contents[member.name])

def member(name, kind="file", mode=0o644, contents=b""):
    item = module.tarfile.TarInfo(name)
    item.type = module.tarfile.DIRTYPE if kind == "dir" else module.tarfile.REGTYPE
    item.mode = mode
    item.uid = item.gid = 0
    item.size = len(contents)
    return item, contents

control = member("./control", contents=b"package control")
md5sums = member("./md5sums", contents=b"")
def validate(data_members, extra_control=(), candidate_helper=helper_bytes):
    def inspect(_path, option, visitor):
        if option == "--ctrl-tarfile":
            values = [member("./", "dir"), control, md5sums, *extra_control]
        else:
            values = [member("./", "dir"), member("./opt", "dir"), member("./opt/factory-desktop-linux", "dir"),
                      member("./opt/factory-desktop-linux/factory-desktop", contents=b"app"),
                      member("./opt/factory-desktop-linux/build-manifest.json", contents=manifest_bytes),
                      member("." + module.FIXED_HELPER_PATH, mode=0o755, contents=candidate_helper),
                      *data_members]
        stream = FakeTar({entry.name: body for entry, body in values})
        for entry, _body in values: visitor(stream, entry)
    module.inspect_deb_tar = inspect
    module.validate_deb_payload("candidate.deb", trusted)

validate([])
try: validate([member("/etc/evil", contents=b"bad")])
except module.InstallError as error: assert "absolute or invalid archive path" in str(error)
else: raise AssertionError("unexpected DEB payload path was accepted")

try: validate([], candidate_helper=b"changed helper")
except module.InstallError as error: assert "replace the fixed authorization helper" in str(error)
else: raise AssertionError("changed authorization helper was accepted")

try: validate([], [member("./postinst", contents=b"#!/bin/sh\\n")])
except module.InstallError as error: assert "maintainer script" in str(error)
else: raise AssertionError("DEB maintainer script was accepted")

try:
    validate([member("./opt/factory-desktop-linux/unsafe", mode=0o777, contents=b"bad")])
except module.InstallError as error: assert "unsafe permissions" in str(error)
else: raise AssertionError("world-writable DEB payload was accepted")

def requirement_runner(command, args, **kwargs):
    if command == "/usr/bin/dpkg-deb":
        return type("Result", (), {"stdout": metadata, "returncode": 0, "stderr": ""})()
    if command == "/usr/bin/dpkg-query" and "-f=\${Depends}" in args:
        return type("Result", (), {"stdout": "python3, util-linux", "returncode": 0, "stderr": ""})()
    if command == "/usr/bin/dpkg-query":
        return type("Result", (), {"stdout": "installed", "returncode": 0, "stderr": ""})()
    raise AssertionError("unexpected dependency command")
module.run_fixed = requirement_runner
module.validate_deb_requirements(module.deb_identity("candidate.deb"))
metadata = metadata.replace("Depends: python3, util-linux", "Depends: python3, new-package")
try: module.validate_deb_requirements(module.deb_identity("candidate.deb"))
except module.InstallError as error: assert "introduces or changes dependencies" in str(error)
else: raise AssertionError("new package dependency was accepted")
`;
  const result = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test('DEB helper parses a real dpkg-deb archive without maintainer scripts', async (t) => {
  if (spawnSync('dpkg-deb', ['--version'], { encoding: 'utf8' }).status !== 0) {
    t.skip('dpkg-deb is unavailable');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-deb-helper-test-'));
  try {
    const packageRoot = path.join(root, 'package');
    const control = path.join(packageRoot, 'DEBIAN');
    await mkdir(control, { recursive: true });
    await chmod(packageRoot, 0o755);
    await chmod(control, 0o755);
    await mkdir(path.join(packageRoot, 'opt/factory-desktop-linux'), { recursive: true });
    await mkdir(path.join(packageRoot, 'usr/bin'), { recursive: true });
    await mkdir(path.join(packageRoot, 'usr/share/doc/factory-desktop-linux'), { recursive: true });
    await writeFile(path.join(control, 'control'), [
      'Package: factory-desktop-linux',
      'Version: 0.194.0-1ubuntu26.04',
      'Section: devel',
      'Priority: optional',
      'Architecture: amd64',
      'Depends: libc6',
      `X-Factory-Build-Manifest-SHA256: ${createHash('sha256').update('build manifest').digest('hex')}`,
      'X-Factory-Updater: no',
      'Maintainer: Local Test <test@example.invalid>',
      'Description: test package',
      '',
    ].join('\n'));
    await writeFile(path.join(packageRoot, 'opt/factory-desktop-linux/factory-desktop'), 'app');
    await writeFile(
      path.join(packageRoot, 'opt/factory-desktop-linux/build-manifest.json'),
      'build manifest',
    );
    await writeFile(path.join(packageRoot, 'usr/bin/factory-desktop-linux'), 'wrapper');
    await writeFile(
      path.join(packageRoot, 'usr/share/doc/factory-desktop-linux/PERSONAL-USE-NOTICE.txt'),
      'personal-use notice',
    );
    const debPath = path.join(root, 'candidate.deb');
    const build = spawnSync('dpkg-deb', [
      '--build', '--root-owner-group', packageRoot, debPath,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
    const validate = `
import sys, types
sys.dont_write_bytecode = True
module = types.ModuleType("helper_real_deb_test")
helper_path = ${JSON.stringify(helperPath)}
exec(compile(open(helper_path, encoding="utf8").read(), helper_path, "exec"), module.__dict__)
fields = module.deb_identity(${JSON.stringify(debPath)})
assert fields["Version"] == "0.194.0-1ubuntu26.04"
module.validate_deb_payload(${JSON.stringify(debPath)}, "a" * 64, require_helper=False)
`;
    const result = spawnSync('python3', ['-c', validate], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
