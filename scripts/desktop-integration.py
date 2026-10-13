#!/usr/bin/env python3
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

APP_ID = "factory.desktop"
APP_NAME = "Factory Desktop Linux"


def fail(message):
    raise RuntimeError(message)


def home():
    return Path(os.environ.get("HOME", str(Path.home()))).expanduser()


def data_home():
    return Path(os.environ.get("XDG_DATA_HOME", home() / ".local/share")).expanduser()


def config_home():
    return Path(os.environ.get("XDG_CONFIG_HOME", home() / ".config")).expanduser()


def state_home():
    return Path(os.environ.get("XDG_STATE_HOME", home() / ".local/state")).expanduser()


def active_desktops():
    result = []
    for desktop in os.environ.get("XDG_CURRENT_DESKTOP", "").split(":"):
        desktop = desktop.strip().lower()
        if desktop and re.fullmatch(r"[a-z0-9_-]+", desktop) and desktop not in result:
            result.append(desktop)
    return result


def user_mime_files():
    names = ["mimeapps.list"] + [f"{desktop}-mimeapps.list" for desktop in active_desktops()]
    candidates = []
    for filename in names:
        candidates.append(config_home() / filename)
        candidates.append(data_home() / "applications" / filename)
    return list(dict.fromkeys(candidates))


def ensure_no_symlink(path):
    current = path
    while current != current.parent:
        if current.is_symlink():
            fail(f"Refusing to use a symlink in a desktop integration path: {current}")
        current = current.parent


def digest(content):
    return hashlib.sha256(content).hexdigest()


def snapshot(paths):
    records = {}
    for path in paths:
        ensure_no_symlink(path)
        if path.exists():
            if not path.is_file():
                fail(f"Expected a regular MIME association file: {path}")
            contents = path.read_bytes()
            records[str(path)] = {
                "exists": True,
                "mode": path.stat().st_mode & 0o777,
                "content": base64.b64encode(contents).decode("ascii"),
                "sha256": digest(contents),
            }
        else:
            records[str(path)] = {"exists": False, "sha256": None}
    return records


def write_atomic(path, contents, mode):
    ensure_no_symlink(path.parent)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.port-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(contents)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def restore_snapshot(records):
    for name, record in records.items():
        path = Path(name)
        ensure_no_symlink(path)
        if record["exists"]:
            contents = base64.b64decode(record["content"], validate=True)
            if digest(contents) != record["sha256"]:
                fail(f"Stored MIME association snapshot is corrupt: {path}")
            write_atomic(path, contents, record["mode"])
        elif path.exists():
            if not path.is_file():
                fail(f"Refusing to remove a non-file MIME association: {path}")
            path.unlink()


def current_default(mime):
    executable = shutil.which("xdg-mime")
    if not executable:
        fail("xdg-mime is required for desktop integration.")
    result = subprocess.run(
        [executable, "query", "default", mime],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if result.returncode:
        return ""
    return result.stdout.strip()


def validate_handler(handler):
    if not handler:
        return
    if not re.fullmatch(r"[A-Za-z0-9_.+-]+\.desktop", handler):
        fail(f"The current callback association is not a safe desktop-file identifier: {handler}")


def quote_exec(value):
    if "\0" in value or "\n" in value or "\r" in value:
        fail("Desktop entry paths may not contain NUL or newline characters.")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    escaped = escaped.replace("`", "\\`").replace("$", "\\$").replace("%", "%%")
    return '"' + escaped + '"'


def icon_value(value):
    if "\0" in value or "\n" in value or "\r" in value:
        fail("Desktop entry icon paths may not contain NUL or newline characters.")
    return value.replace("\\", "\\\\").replace("\t", "\\t")


def entry_contents(launch, icon, scheme):
    return "\n".join([
        "[Desktop Entry]",
        "Type=Application",
        f"Name={APP_NAME}",
        "Comment=Unofficial personal-use Factory Desktop port",
        f"Exec={quote_exec(launch)} %u",
        f"Icon={icon_value(icon)}",
        "Terminal=false",
        "Categories=Development;",
        f"MimeType=x-scheme-handler/{scheme};",
        "",
    ]).encode("utf-8")


def install():
    helper_dir = Path(__file__).resolve().parent
    root = helper_dir.parent
    scheme_file = root / "resources/protocol-scheme"
    app = root / "factory-desktop"
    normal_launcher = root / "launch.sh"
    if not scheme_file.is_file() or not app.is_file() or not normal_launcher.is_file():
        fail("The packaged app or callback scheme is missing. Build the portable app first.")
    launcher_name = os.environ.get("FACTORY_DESKTOP_LAUNCHER", "launch.sh")
    if launcher_name not in ("launch.sh", "launch-test.sh"):
        fail("FACTORY_DESKTOP_LAUNCHER must be launch.sh or launch-test.sh.")
    launcher = root / launcher_name
    if not launcher.is_file() or not os.access(launcher, os.X_OK):
        fail(f"The selected launcher is missing or not executable: {launcher}")
    scheme = scheme_file.read_text(encoding="utf-8").splitlines()[0].strip()
    if not re.fullmatch(r"[a-z][a-z0-9+.-]{1,62}", scheme):
        fail(f"Invalid callback scheme in {scheme_file}.")
    icon = next((candidate for candidate in (
        root / "resources/factory-desktop.png",
        root / "resources/factory-desktop.svg",
    ) if candidate.is_file()), None)
    if not icon:
        fail("The packaged application icon is missing.")

    applications = data_home() / "applications"
    entry_path = applications / APP_ID
    state = state_home() / "factory-desktop-linux"
    backup = state / "protocol-association"
    for item in (applications, entry_path, state, backup):
        ensure_no_symlink(item)
    if entry_path.exists():
        fail(f"Refusing to overwrite an existing desktop entry: {entry_path}")
    if backup.exists():
        fail(f"An installation backup already exists at {backup}. Roll back before installing again.")

    mime = f"x-scheme-handler/{scheme}"
    old_default = current_default(mime)
    validate_handler(old_default)
    if old_default == APP_ID:
        fail(f"The callback scheme already resolves to {APP_ID} outside this install.")
    if old_default:
        if not sys.stdin.isatty():
            fail("No interactive approval available; not changing the existing callback handler.")
        answer = input(f"The current {scheme} handler is {old_default}. Replace it with this personal port? [y/N] ")
        if answer not in ("y", "Y", "yes", "YES"):
            print("No changes made.")
            return

    before_files = snapshot(user_mime_files())
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup.mkdir(mode=0o700)
    entry_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    before_record = {
        "scheme": scheme,
        "mime": mime,
        "oldDefault": old_default,
        "launcher": launcher_name,
        "before": before_files,
    }
    (backup / "before.json").write_text(json.dumps(before_record, indent=2) + "\n", encoding="utf-8")
    os.chmod(backup / "before.json", 0o600)
    contents = entry_contents(str(launcher), str(icon), scheme)
    try:
        with entry_path.open("xb") as output:
            output.write(contents)
        os.chmod(entry_path, 0o644)
        observed_default = current_default(mime)
        if observed_default not in (old_default, APP_ID):
            fail(f"The {scheme} callback handler changed during installation; refusing to replace it.")
        executable = shutil.which("xdg-mime")
        result = subprocess.run(
            [executable, "default", APP_ID, mime],
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode:
            fail(f"Could not register callback handler: {(result.stderr or result.stdout).strip()}")
        if current_default(mime) != APP_ID:
            fail(f"The effective {scheme} handler did not become {APP_ID}.")
        after_files = snapshot(user_mime_files())
        record = {
            **before_record,
            "entrySha256": digest(contents),
            "after": after_files,
        }
        (backup / "association.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        os.chmod(backup / "association.json", 0o600)
    except Exception:
        try:
            restore_snapshot(before_files)
            if entry_path.is_file() and digest(entry_path.read_bytes()) == digest(contents):
                entry_path.unlink()
            shutil.rmtree(backup)
        except Exception as restore_error:
            fail(f"Desktop integration failed and automatic rollback was incomplete: {restore_error}")
        raise
    print(f"Installed {scheme} handler. Previous association and MIME file snapshots are recorded at {backup}.")


def rollback():
    helper_dir = Path(__file__).resolve().parent
    root = helper_dir.parent
    state = state_home() / "factory-desktop-linux"
    backup = state / "protocol-association"
    metadata_path = backup / "association.json"
    if not metadata_path.is_file():
        fail(f"No complete desktop-integration backup found at {metadata_path}.")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    scheme = metadata.get("scheme", "")
    if not re.fullmatch(r"[a-z][a-z0-9+.-]{1,62}", scheme):
        fail("Invalid callback scheme in rollback record.")
    mime = f"x-scheme-handler/{scheme}"
    if current_default(mime) != APP_ID:
        fail(f"Current handler is {current_default(mime) or '<none>'}, not {APP_ID}. Refusing to overwrite a newer association.")
    entry_path = data_home() / "applications" / APP_ID
    if not entry_path.is_file() or digest(entry_path.read_bytes()) != metadata.get("entrySha256"):
        fail("The installed desktop entry is missing or changed. Refusing to remove it.")
    current_files = snapshot(user_mime_files())
    after = metadata.get("after", {})
    for name, record in after.items():
        observed = current_files.get(name)
        if observed != record:
            fail(f"An active MIME association file changed after installation: {name}. Refusing rollback.")
    for name, observed in current_files.items():
        if name not in after and observed["exists"]:
            fail(f"A new active MIME association file appeared after installation: {name}. Refusing rollback.")

    restore_snapshot(metadata.get("before", {}))
    entry_path.unlink()
    shutil.rmtree(backup)
    print(f"Restored the previous {scheme} association and removed the personal desktop entry.")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("install", "rollback"):
        fail("Usage: desktop-integration.py install|rollback")
    (install if sys.argv[1] == "install" else rollback)()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"desktop-integration: {error}", file=sys.stderr)
        sys.exit(1)
