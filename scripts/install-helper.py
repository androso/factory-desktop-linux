#!/usr/bin/python3
"""Root-owned, fixed-command installer for verified Factory Desktop packages."""

import argparse
import hashlib
import os
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

PACKAGE_NAME = "factory-desktop-linux"
MAX_RPM_BYTES = 2 * 1024 * 1024 * 1024
MAX_DEB_BYTES = MAX_RPM_BYTES
SAFE_ENV = {"PATH": "/usr/sbin:/usr/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"}
FIXED_HELPER_PATH = "/usr/libexec/factory-desktop-linux/install-helper"
EXACT_PATHS = {
    "/usr/bin/factory-desktop-linux",
    "/usr/bin/factory-update-manager",
    "/usr/lib/systemd/user/factory-update-manager.service",
    "/usr/lib/systemd/user/factory-update-manager.timer",
    "/usr/share/applications/factory-desktop-linux.desktop",
    "/usr/share/licenses/factory-desktop-linux/PERSONAL-USE-NOTICE.txt",
}
ICON_PATH = re.compile(r"^/usr/share/icons/hicolor/(?:scalable|\d+x\d+)/apps/factory-desktop-linux\.(?:svg|png)$")


class InstallError(Exception):
    pass


def run_fixed(command, args, *, check=True):
    result = subprocess.run(
        [command, *args],
        env=SAFE_ENV,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=1800,
        check=False,
    )
    if check and result.returncode != 0:
        raise InstallError(result.stderr.strip() or f"{command} exited with status {result.returncode}.")
    return result


def inspect_deb_tar(deb_path, option, visitor):
    process = subprocess.Popen(
        ["/usr/bin/dpkg-deb", option, deb_path],
        env=SAFE_ENV,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    total_size = 0
    member_count = 0
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|*") as tar:
            for member in tar:
                member_count += 1
                total_size += max(0, member.size)
                if member_count > 100000 or total_size > MAX_DEB_BYTES:
                    raise InstallError("DEB archive exceeds the member or expanded-size limit.")
                visitor(tar, member)
        try:
            status = process.wait(timeout=1800)
        except subprocess.TimeoutExpired as error:
            process.kill()
            process.wait()
            raise InstallError("DEB archive inspection timed out.") from error
        if status != 0:
            raise InstallError(f"dpkg-deb {option} failed while inspecting the candidate.")
    except Exception:
        if process.poll() is None:
            process.kill()
            process.wait()
        raise


def stable_user_copy(source, expected_sha256, invoking_uid, *, suffix=".rpm", maximum_bytes=MAX_RPM_BYTES):
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha256 or ""):
        raise InstallError("Candidate checksum must be a lowercase SHA-256.")
    if not os.path.isabs(source) or "\x00" in source:
        raise InstallError("Candidate path must be an absolute path.")

    components = [part for part in source.split("/") if part]
    if not components:
        raise InstallError("Candidate path is empty.")
    directory_fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    input_fd = None
    try:
        for component in components[:-1]:
            if component in (".", ".."):
                raise InstallError("Candidate path contains a traversal component.")
            next_fd = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                dir_fd=directory_fd,
            )
            info = os.fstat(next_fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, invoking_uid):
                os.close(next_fd)
                raise InstallError("Candidate directory is not owned by root or the invoking user.")
            if info.st_mode & 0o022 and not (info.st_uid == 0 and info.st_mode & stat.S_ISVTX):
                os.close(next_fd)
                raise InstallError("Candidate directory is writable by other users.")
            os.close(directory_fd)
            directory_fd = next_fd

        input_fd = os.open(
            components[-1],
            os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW,
            dir_fd=directory_fd,
        )
        info = os.fstat(input_fd)
        if (
            not stat.S_ISREG(info.st_mode) or info.st_uid != invoking_uid or
            info.st_mode & 0o022 or info.st_size < 1024 or info.st_size > maximum_bytes
        ):
            raise InstallError("Candidate must be a bounded, regular RPM owned by the invoking user.")

        output_fd, stable_path = tempfile.mkstemp(prefix="factory-desktop-", suffix=suffix, dir="/var/tmp")
        digest = hashlib.sha256()
        size = 0
        try:
            with os.fdopen(output_fd, "wb") as output:
                while True:
                    chunk = os.read(input_fd, 1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > maximum_bytes:
                        raise InstallError("Candidate package exceeds the permitted size.")
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if size != info.st_size or digest.hexdigest() != expected_sha256:
                raise InstallError("Candidate changed or failed its SHA-256 check while being stabilized.")
            os.chmod(stable_path, 0o600)
            return stable_path
        except Exception:
            try:
                os.unlink(stable_path)
            except FileNotFoundError:
                pass
            raise
    finally:
        if input_fd is not None:
            os.close(input_fd)
        os.close(directory_fd)


def rpm_identity(rpm_path):
    result = run_fixed(
        "/usr/bin/rpm",
        ["-qp", "--queryformat", "%{NAME}\t%{EPOCHNUM}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\n", rpm_path],
    )
    fields = result.stdout.strip().split("\t")
    if len(fields) != 5:
        raise InstallError("Candidate RPM identity could not be read.")
    name, epoch, version, release, architecture = fields
    if (
        name != PACKAGE_NAME or
        epoch != "0" or
        not re.fullmatch(r"\d+\.\d+\.\d+", version) or
        not re.fullmatch(r"\d+\.fc44", release) or
        architecture != "x86_64"
    ):
        raise InstallError("Candidate RPM is not a Fedora 44 x86_64 Factory Desktop package.")
    return name, version, release, architecture


def trusted_helper_backup():
    try:
        info = os.stat(FIXED_HELPER_PATH, follow_symlinks=False)
    except OSError as error:
        raise InstallError(f"Cannot inspect the installed authorization helper: {error}") from error
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise InstallError("The installed authorization helper has unsafe ownership or permissions.")
    digest = hashlib.sha256()
    chunks = []
    with open(FIXED_HELPER_PATH, "rb") as helper_file:
        for chunk in iter(lambda: helper_file.read(1024 * 1024), b""):
            digest.update(chunk)
            chunks.append(chunk)
    return digest.hexdigest(), b"".join(chunks)


def validate_rpm_payload(rpm_path, helper_digest, *, allow_helper_omission=False):
    for option in ("--scripts", "--triggers", "--filetriggers", "--transfiletriggers"):
        result = run_fixed("/usr/bin/rpm", ["-qp", option, rpm_path])
        if result.stdout.strip():
            raise InstallError("Candidate RPM contains install-time scripts or triggers.")

    result = run_fixed(
        "/usr/bin/rpm",
        ["-qp", "--queryformat",
         "[%{FILENAMES}\t%{FILEMODES}\t%{FILEDIGESTS}\t%{FILECAPS}\t%{FILELINKTOS}\n]", rpm_path],
    )
    entries = result.stdout.splitlines()
    if not entries:
        raise InstallError("Candidate RPM has an empty payload.")
    helper_seen = False
    for entry in entries:
        fields = entry.split("\t")
        if len(fields) != 5:
            raise InstallError("Candidate RPM payload metadata is malformed.")
        filename, raw_mode, file_digest, file_caps, file_link = fields
        if not filename.startswith("/") or os.path.normpath(filename) != filename:
            raise InstallError("Candidate RPM contains a non-canonical file path.")
        try:
            mode = int(raw_mode)
        except ValueError as error:
            raise InstallError("Candidate RPM contains an invalid file mode.") from error
        kind = stat.S_IFMT(mode)
        if filename == FIXED_HELPER_PATH:
            helper_seen = True
            if file_digest != helper_digest:
                raise InstallError("Candidate RPM attempts to replace the fixed authorization helper.")
        allowed = (
            filename == "/opt" or filename == "/opt/factory-desktop-linux" or
            filename.startswith("/opt/factory-desktop-linux/") or
            filename in EXACT_PATHS or filename == FIXED_HELPER_PATH or ICON_PATH.fullmatch(filename)
        )
        if not allowed or kind not in (stat.S_IFDIR, stat.S_IFREG):
            raise InstallError(f"Candidate RPM contains an unexpected payload path or type: {filename}.")
        if mode & (stat.S_ISUID | stat.S_ISGID) or mode & 0o022:
            raise InstallError(f"Candidate RPM payload has unsafe permissions: {filename}.")
        if file_caps not in ("", "none", "(none)") or file_link not in ("", "none", "(none)"):
            raise InstallError(f"Candidate RPM contains file capabilities or links: {filename}.")
    if not helper_seen and not allow_helper_omission:
        raise InstallError("Candidate RPM omitted the installed authorization helper.")


def restore_authorization_helper(contents, expected_digest):
    directory = os.path.dirname(FIXED_HELPER_PATH)
    os.makedirs(directory, mode=0o755, exist_ok=True)
    directory_info = os.stat(directory, follow_symlinks=False)
    if (
        not stat.S_ISDIR(directory_info.st_mode) or directory_info.st_uid != 0 or
        directory_info.st_mode & 0o022
    ):
        raise InstallError("Authorization helper directory has unsafe ownership or permissions.")
    try:
        current = hashlib.sha256()
        with open(FIXED_HELPER_PATH, "rb") as helper_file:
            for chunk in iter(lambda: helper_file.read(1024 * 1024), b""):
                current.update(chunk)
        if current.hexdigest() == expected_digest:
            return
    except FileNotFoundError:
        pass

    descriptor, temporary = tempfile.mkstemp(prefix=".install-helper-", dir=directory)
    try:
        os.fchmod(descriptor, 0o755)
        os.fchown(descriptor, 0, 0)
        with os.fdopen(descriptor, "wb") as helper_file:
            helper_file.write(contents)
            helper_file.flush()
            os.fsync(helper_file.fileno())
        os.replace(temporary, FIXED_HELPER_PATH)
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def package_requirements(rpm_path):
    result = run_fixed("/usr/bin/rpm", ["-qp", "--requires", rpm_path])
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def validate_candidate_requirements(candidate_path):
    current_result = run_fixed("/usr/bin/rpm", ["-q", "--requires", PACKAGE_NAME])
    current = {line.strip() for line in current_result.stdout.splitlines() if line.strip()}
    candidate = package_requirements(candidate_path)
    unexpected = sorted(candidate - current)
    if unexpected:
        raise InstallError(
            "Candidate RPM introduces new dependencies; install it manually after reviewing them: " +
            ", ".join(unexpected[:12])
        )
    for option in ("--obsoletes", "--conflicts", "--recommends", "--suggests",
                   "--supplements", "--enhances"):
        result = run_fixed("/usr/bin/rpm", ["-qp", option, candidate_path])
        if result.stdout.strip():
            raise InstallError(f"Candidate RPM declares unsupported package relationships: {option}.")


def current_rpm_identity():
    result = run_fixed(
        "/usr/bin/rpm",
        ["-q", "--queryformat", "%{NAME}\t%{EPOCHNUM}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\n", PACKAGE_NAME],
        check=False,
    )
    if result.returncode == 1:
        return None
    if result.returncode != 0:
        raise InstallError(result.stderr.strip() or "Could not query the installed Factory Desktop package.")
    fields = result.stdout.strip().split("\t")
    if len(fields) != 5 or fields[0] != PACKAGE_NAME or fields[1] != "0" or fields[4] != "x86_64":
        raise InstallError("Installed Factory Desktop RPM identity is malformed.")
    return tuple(fields)


def choose_dnf_operation(candidate, current):
    if current is None:
        return "install"
    if candidate[2:4] == current[2:4]:
        return "reinstall"
    expression = f'%{{lua:print(rpm.vercmp("{candidate[2]}-{candidate[3]}", "{current[2]}-{current[3]}"))}}'
    result = run_fixed("/usr/bin/rpm", ["--eval", expression])
    try:
        comparison = int(result.stdout.strip())
    except ValueError as error:
        raise InstallError("RPM version comparison returned an invalid result.") from error
    return "downgrade" if comparison < 0 else "install"


def assert_no_running_factory_app():
    try:
        entries = os.scandir("/proc")
    except OSError as error:
        raise InstallError(f"Cannot inspect running processes: {error}") from error
    with entries:
        for entry in entries:
            if not entry.name.isdecimal() or not entry.is_dir(follow_symlinks=False):
                continue
            executable_path = f"/proc/{entry.name}/exe"
            try:
                executable = os.readlink(executable_path).removesuffix(" (deleted)")
            except OSError as error:
                if error.errno in (2, 3, 13, 1):
                    continue
                raise InstallError(f"Cannot inspect process {entry.name}: {error}") from error
            if os.path.basename(executable) == "factory-desktop" or executable.startswith("/opt/factory-desktop-linux/"):
                raise InstallError(f"Factory Desktop is still running (PID {entry.name}).")


def install(candidate_path, sha256, invoking_uid):
    stable_path = stable_user_copy(candidate_path, sha256, invoking_uid)
    try:
        candidate = rpm_identity(stable_path)
        current = current_rpm_identity()
        if current is None:
            raise InstallError("The fixed updater can only update an already installed Factory Desktop RPM.")
        operation = choose_dnf_operation(candidate, current)
        helper_digest, helper_backup = trusted_helper_backup()
        validate_rpm_payload(
            stable_path,
            helper_digest,
            allow_helper_omission=(operation == "downgrade"),
        )
        assert_no_running_factory_app()
        validate_candidate_requirements(stable_path)
        try:
            run_fixed("/usr/bin/dnf", [operation, "-y", stable_path])
        finally:
            restore_authorization_helper(helper_backup, helper_digest)
        installed = current_rpm_identity()
        if installed != candidate:
            raise InstallError("Installed RPM identity differs from the approved candidate.")
        run_fixed("/usr/bin/rpm", ["-V", PACKAGE_NAME])
    finally:
        try:
            os.unlink(stable_path)
        except FileNotFoundError:
            pass


DEB_EXACT_PATHS = {
    "/usr/bin/factory-desktop-linux",
    "/usr/bin/factory-update-manager",
    "/usr/libexec/factory-desktop-linux/install-helper",
    "/usr/lib/systemd/user/factory-update-manager.service",
    "/usr/lib/systemd/user/factory-update-manager.timer",
    "/usr/share/applications/factory-desktop-linux.desktop",
    "/usr/share/doc/factory-desktop-linux/PERSONAL-USE-NOTICE.txt",
}
DEB_ICON_PATH = re.compile(
    r"^/usr/share/icons/hicolor/(?:scalable|\d+x\d+)/apps/factory-desktop-linux\.(?:svg|png)$"
)
DEB_ALLOWED_CONTROL_FIELDS = {
    "Package", "Version", "Section", "Priority", "Architecture", "Depends",
    "Installed-Size", "X-Factory-Build-Manifest-SHA256", "X-Factory-Updater",
    "Maintainer", "Description",
}


def deb_control_fields(deb_path):
    text = run_fixed("/usr/bin/dpkg-deb", ["-f", deb_path]).stdout
    fields = {}
    current = None
    for line in text.splitlines():
        if line.startswith((" ", "\t")):
            if current is None:
                raise InstallError("DEB control metadata has an orphaned continuation.")
            fields[current] += "\n" + line[1:]
            continue
        if ":" not in line:
            raise InstallError("DEB control metadata is malformed.")
        name, value = line.split(":", 1)
        if name in fields:
            raise InstallError(f"DEB control metadata repeats {name}.")
        current = name
        fields[name] = value.strip()
    unexpected = set(fields) - DEB_ALLOWED_CONTROL_FIELDS
    if unexpected:
        raise InstallError(
            "DEB contains unsupported control fields: " + ", ".join(sorted(unexpected))
        )
    for required in ("Package", "Version", "Architecture", "Depends", "X-Factory-Build-Manifest-SHA256", "X-Factory-Updater"):
        if not fields.get(required):
            raise InstallError(f"DEB omitted required control field {required}.")
    return fields


def deb_identity(deb_path):
    fields = deb_control_fields(deb_path)
    if (
        fields["Package"] != PACKAGE_NAME or
        not re.fullmatch(r"\d+\.\d+\.\d+-1ubuntu26\.04", fields["Version"]) or
        fields["Architecture"] != "amd64" or
        not re.fullmatch(r"[a-f0-9]{64}", fields["X-Factory-Build-Manifest-SHA256"]) or
        fields["X-Factory-Updater"] not in ("yes", "no")
    ):
        raise InstallError("Candidate DEB is not a valid Ubuntu 26.04 x86_64 Factory Desktop package.")
    return fields


def canonical_deb_path(name):
    if not isinstance(name, str) or name.startswith("/") or "\x00" in name:
        raise InstallError("DEB contains an absolute or invalid archive path.")
    relative = name[2:] if name.startswith("./") else name
    if relative in ("", "."):
        return "/"
    parts = relative.rstrip("/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise InstallError("DEB contains a non-canonical archive path.")
    return "/" + "/".join(parts)


def allowed_deb_path(filename, is_directory):
    if filename in DEB_EXACT_PATHS or DEB_ICON_PATH.fullmatch(filename):
        return not is_directory
    if filename == "/opt" or filename == "/opt/factory-desktop-linux" or filename.startswith("/opt/factory-desktop-linux/"):
        return True
    if is_directory and filename in {
        "/usr", "/usr/bin", "/usr/lib", "/usr/libexec",
        "/usr/libexec/factory-desktop-linux", "/usr/lib/systemd",
        "/usr/lib/systemd/user", "/usr/share", "/usr/share/applications",
        "/usr/share/doc", "/usr/share/doc/factory-desktop-linux",
        "/usr/share/icons", "/usr/share/icons/hicolor",
    }:
        return True
    if is_directory and re.fullmatch(r"/usr/share/icons/hicolor/(?:scalable|\d+x\d+)(?:/apps)?", filename):
        return True
    return False


def validate_deb_control_archive(deb_path):
    names = set()
    control_count = 0

    def inspect(tar, member):
        nonlocal control_count
        filename = canonical_deb_path(member.name)
        if filename == "/":
            if not member.isdir():
                raise InstallError("DEB control archive root is not a directory.")
            return
        if not member.isfile() or member.mode & (stat.S_ISUID | stat.S_ISGID | 0o022):
            raise InstallError("DEB control archive contains a link, special file, or unsafe mode.")
        if filename not in ("/control", "/md5sums"):
            raise InstallError(f"DEB contains a maintainer script, trigger, or unexpected control file: {filename}.")
        if filename in names:
            raise InstallError(f"DEB control archive repeats {filename}.")
        names.add(filename)
        if filename == "/control":
            control_count += 1
        if filename == "/md5sums":
            if member.size > 16 * 1024 * 1024:
                raise InstallError("DEB md5sums metadata is too large.")
            stream = tar.extractfile(member)
            contents = stream.read(16 * 1024 * 1024 + 1) if stream else b""
            if len(contents) > 16 * 1024 * 1024:
                raise InstallError("DEB md5sums metadata is too large.")
            for line in contents.decode("ascii", "strict").splitlines():
                match = re.fullmatch(r"([a-f0-9]{32})  ([^\x00\r\n]+)", line)
                if not match:
                    raise InstallError("DEB contains malformed md5sums metadata.")
                canonical_deb_path(match.group(2))
        elif filename == "/control":
            if member.size > 1024 * 1024:
                raise InstallError("DEB control metadata is too large.")
            stream = tar.extractfile(member)
            if stream:
                stream.read(1024 * 1024 + 1)

    inspect_deb_tar(deb_path, "--ctrl-tarfile", inspect)
    if control_count != 1:
        raise InstallError("DEB control archive must contain exactly one control file.")


def validate_deb_payload(deb_path, helper_digest, *, require_helper=True):
    validate_deb_control_archive(deb_path)
    fields = deb_identity(deb_path)
    helper_seen = False
    manifest_seen = False
    seen = set()
    kinds = {}
    has_children = set()

    def inspect(tar, member):
        nonlocal helper_seen, manifest_seen
        filename = canonical_deb_path(member.name)
        if filename == "/":
            if not member.isdir():
                raise InstallError("DEB payload root is not a directory.")
            return
        if filename in seen:
            raise InstallError(f"DEB repeats a payload path: {filename}.")
        seen.add(filename)
        is_directory = member.isdir()
        parent = os.path.dirname(filename)
        while parent not in ("", "/"):
            if kinds.get(parent) == "file":
                raise InstallError(f"DEB payload nests a file below a non-directory: {filename}.")
            parent = os.path.dirname(parent)
        if not is_directory and filename in has_children:
            raise InstallError(f"DEB payload replaces a directory with a file: {filename}.")
        kinds[filename] = "directory" if is_directory else "file"
        ancestor = os.path.dirname(filename)
        while ancestor not in ("", "/"):
            has_children.add(ancestor)
            ancestor = os.path.dirname(ancestor)
        if not (is_directory or member.isfile()):
            raise InstallError(f"DEB contains a link or special payload member: {filename}.")
        if not allowed_deb_path(filename, is_directory):
            raise InstallError(f"DEB contains an unexpected payload path: {filename}.")
        if member.uid != 0 or member.gid != 0:
            raise InstallError(f"DEB payload is not owned by root:root: {filename}.")
        if member.mode & (stat.S_ISUID | stat.S_ISGID | 0o022):
            raise InstallError(f"DEB payload has unsafe permissions: {filename}.")
        if filename == FIXED_HELPER_PATH:
            helper_seen = True
            if member.size > 2 * 1024 * 1024:
                raise InstallError("Candidate authorization helper is unexpectedly large.")
            stream = tar.extractfile(member)
            contents = stream.read(2 * 1024 * 1024 + 1) if stream else b""
            digest = hashlib.sha256(contents).hexdigest()
            if digest != helper_digest:
                raise InstallError("Candidate DEB attempts to replace the fixed authorization helper.")
        if filename == "/opt/factory-desktop-linux/build-manifest.json":
            if member.size > 4 * 1024 * 1024:
                raise InstallError("Candidate build manifest is unexpectedly large.")
            stream = tar.extractfile(member)
            contents = stream.read(4 * 1024 * 1024 + 1) if stream else b""
            if hashlib.sha256(contents).hexdigest() != fields["X-Factory-Build-Manifest-SHA256"]:
                raise InstallError("Candidate DEB build manifest does not match its control metadata.")
            manifest_seen = True
    inspect_deb_tar(deb_path, "--fsys-tarfile", inspect)
    if not manifest_seen:
        raise InstallError("Candidate DEB omitted the build manifest.")
    if fields["X-Factory-Updater"] == "yes" and not helper_seen:
        raise InstallError("Managed updater DEB omitted its fixed authorization helper.")
    if fields["X-Factory-Updater"] == "no" and helper_seen:
        raise InstallError("Manual-only DEB unexpectedly contains the privileged authorization helper.")
    if require_helper and not helper_seen:
        raise InstallError("Candidate DEB omitted the installed authorization helper.")
    return fields


def current_deb_identity():
    result = run_fixed(
        "/usr/bin/dpkg-query",
        ["-W", "-f=${Package}\t${Version}\t${Architecture}\n", PACKAGE_NAME],
        check=False,
    )
    if result.returncode == 1 and "no packages found matching" in result.stderr.lower():
        return None
    if result.returncode != 0:
        raise InstallError(result.stderr.strip() or "Could not query the installed Factory Desktop DEB.")
    fields = result.stdout.strip().split("\t")
    if len(fields) != 3 or fields[0] != PACKAGE_NAME or fields[2] != "amd64":
        raise InstallError("Installed Factory Desktop DEB identity is malformed.")
    status = run_fixed(
        "/usr/bin/dpkg-query",
        ["-W", "-f=${db:Status-Status}", PACKAGE_NAME],
        check=False,
    )
    if status.returncode != 0 or status.stdout.strip() != "installed":
        raise InstallError("Installed Factory Desktop DEB is not fully configured; run make recover.")
    return tuple(fields)


def compare_deb(candidate, current):
    lower = run_fixed(
        "/usr/bin/dpkg", ["--compare-versions", candidate[1], "lt", current[1]], check=False,
    )
    if lower.returncode == 0:
        return "downgrade"
    if lower.returncode != 1:
        raise InstallError("dpkg could not compare candidate package versions.")
    equal = run_fixed(
        "/usr/bin/dpkg", ["--compare-versions", candidate[1], "eq", current[1]], check=False,
    )
    if equal.returncode == 0:
        return "reinstall"
    if equal.returncode != 1:
        raise InstallError("dpkg could not compare candidate package versions.")
    return "install"


def validate_deb_requirements(candidate_fields):
    current = run_fixed(
        "/usr/bin/dpkg-query", ["-W", "-f=${Depends}", PACKAGE_NAME],
    ).stdout.strip()
    current_groups = {item.strip() for item in current.split(",") if item.strip()}
    candidate_groups = {item.strip() for item in candidate_fields["Depends"].split(",") if item.strip()}
    unexpected = sorted(candidate_groups - current_groups)
    if unexpected:
        raise InstallError(
            "Candidate DEB introduces or changes dependencies; install it manually after reviewing them: " +
            ", ".join(unexpected[:12])
        )
    for group in candidate_groups:
        installed = False
        for alternative in group.split("|"):
            name = re.sub(r"\s*\([^)]*\)\s*", "", alternative).strip()
            if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?", name):
                raise InstallError("Candidate DEB contains malformed dependency metadata.")
            status = run_fixed(
                "/usr/bin/dpkg-query", ["-W", "-f=${db:Status-Status}", name], check=False,
            )
            if status.returncode == 0 and status.stdout.strip() == "installed":
                installed = True
                break
        if not installed:
            raise InstallError("Candidate DEB has an unsatisfied dependency; automatic installation was refused.")


def install_deb(candidate_path, sha256, invoking_uid):
    stable_path = stable_user_copy(
        candidate_path, sha256, invoking_uid, suffix=".deb", maximum_bytes=MAX_DEB_BYTES,
    )
    try:
        release = {}
        try:
            with open("/etc/os-release", encoding="utf-8") as os_release:
                for line in os_release:
                    if "=" in line:
                        key, value = line.rstrip("\n").split("=", 1)
                        release[key] = value.strip('"')
        except OSError as error:
            raise InstallError(f"Cannot identify the installation host: {error}") from error
        if release.get("ID") != "ubuntu" or release.get("VERSION_ID") != "26.04":
            raise InstallError("DEB update installation is restricted to Ubuntu 26.04.")
        fields = deb_identity(stable_path)
        candidate = (fields["Package"], fields["Version"], fields["Architecture"])
        current = current_deb_identity()
        if current is None:
            raise InstallError("The fixed updater only updates an already installed Factory Desktop DEB.")
        operation = compare_deb(candidate, current)
        helper_digest, helper_backup = trusted_helper_backup()
        managed = fields["X-Factory-Updater"] == "yes"
        validate_deb_payload(
            stable_path,
            helper_digest,
            require_helper=managed,
        )
        validate_deb_requirements(fields)
        assert_no_running_factory_app()
        try:
            run_fixed("/usr/bin/dpkg", ["--install", stable_path])
        finally:
            restore_authorization_helper(helper_backup, helper_digest)
        installed = current_deb_identity()
        if installed != candidate:
            raise InstallError("Installed DEB identity differs from the approved candidate.")
        verification = run_fixed("/usr/bin/dpkg", ["--verify", PACKAGE_NAME])
        if verification.stdout.strip():
            raise InstallError("Installed DEB payload differs from the approved candidate.")
    finally:
        try:
            os.unlink(stable_path)
        except FileNotFoundError:
            pass


def parse_args(argv):
    parser = argparse.ArgumentParser(prog="factory-desktop-install-helper")
    package = parser.add_mutually_exclusive_group(required=True)
    package.add_argument("--rpm")
    package.add_argument("--deb")
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args(argv)
    return args


def main(argv=None):
    if os.geteuid() != 0:
        raise InstallError("This helper must be launched by pkexec.")
    raw_uid = os.environ.get("PKEXEC_UID", "")
    if not raw_uid.isdecimal():
        raise InstallError("pkexec did not provide an invoking user identity.")
    invoking_uid = int(raw_uid)
    if invoking_uid == 0:
        raise InstallError("Run the updater as a normal user.")
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if args.deb:
        install_deb(args.deb, args.sha256, invoking_uid)
    else:
        install(args.rpm, args.sha256, invoking_uid)
    print("Factory Desktop installation verified.")


if __name__ == "__main__":
    try:
        main()
    except (InstallError, OSError, subprocess.SubprocessError) as error:
        print(f"factory-desktop-install-helper: {error}", file=sys.stderr)
        sys.exit(1)
