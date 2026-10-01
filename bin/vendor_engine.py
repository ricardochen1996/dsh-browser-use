"""Bundle the engine this plugin drives: one jev-ultrafast wheel, built from a named revision.

The npm package ships the engine as a wheel under vendor/, and pyproject.toml points uv at that file,
so the environment the plugin builds for itself needs PyPI for the engine's dependencies and nothing
else: no git, no GitHub, no sibling checkout. vendor/jev-ultrafast.json records where the wheel came
from, and `check` proves it, file by file, against that revision.

  uv run python bin/vendor_engine.py update ../jev-ultrafast   # rebuild from the checkout's HEAD, relock
  uv run python bin/vendor_engine.py check ../jev-ultrafast    # the wheel holds exactly that revision
"""

import argparse
import email.parser
import json
import re
import shutil
import subprocess
import tempfile
import tomllib
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"
MANIFEST = VENDOR / "jev-ultrafast.json"
PACKAGE = "jev_ultrafast"
REPOSITORY = "https://github.com/ricardochen1996/jev-ultrafast"
SOURCE = re.compile(r'^jev-ultrafast = \{.*\}$', re.MULTILINE)


def git(checkout, *args):
    return subprocess.run(["git", "-C", str(checkout), *args], check=True, capture_output=True, text=True).stdout


def clean_revision(checkout):
    """The checkout's HEAD, refusing local edits: the manifest has to name what the wheel holds."""
    if git(checkout, "status", "--porcelain", "--untracked-files=no").strip():
        raise SystemExit(f"{checkout} has uncommitted changes; commit them so the wheel names a revision.")
    return git(checkout, "rev-parse", "HEAD").strip()


def update(checkout):
    rev = clean_revision(checkout)
    with tempfile.TemporaryDirectory() as out:
        subprocess.run(["uv", "build", "--wheel", "--out-dir", out, str(checkout)], check=True)
        [built] = Path(out).glob("*.whl")
        for old in VENDOR.glob("*.whl"):
            old.unlink()
        VENDOR.mkdir(exist_ok=True)
        wheel = Path(shutil.copy2(built, VENDOR / built.name))
    repository = json.loads(MANIFEST.read_text())["repository"] if MANIFEST.exists() else REPOSITORY
    version = wheel.name.split("-")[1]
    MANIFEST.write_text(json.dumps(
        {"repository": repository, "rev": rev, "version": version, "wheel": wheel.name}, indent=2,
    ) + "\n")
    pyproject = ROOT / "pyproject.toml"
    text = pyproject.read_text()
    if not SOURCE.search(text):
        raise SystemExit("pyproject.toml has no `jev-ultrafast = { ... }` line under [tool.uv.sources].")
    pyproject.write_text(SOURCE.sub(f'jev-ultrafast = {{ path = "vendor/{wheel.name}" }}', text, count=1))
    subprocess.run(["uv", "lock"], cwd=ROOT, check=True)
    print(f"Bundled {wheel.name} from {repository} at {rev}.")


def check(checkout):
    manifest = json.loads(MANIFEST.read_text())
    rev = clean_revision(checkout)
    if rev != manifest["rev"]:
        raise SystemExit(f"{checkout} is at {rev}; check out {manifest['rev']} to compare the bundled wheel.")
    tracked = {path for path in git(checkout, "ls-files", "-z", PACKAGE).split("\0") if path}
    with zipfile.ZipFile(VENDOR / manifest["wheel"]) as wheel:
        names = set(wheel.namelist())
        packaged = {name for name in names if name.startswith(f"{PACKAGE}/")}
        if packaged != tracked:
            raise SystemExit(f"the wheel's files differ from the revision's: {sorted(packaged ^ tracked)}")
        changed = [name for name in sorted(packaged) if wheel.read(name) != (checkout / name).read_bytes()]
        if changed:
            raise SystemExit(f"the wheel's contents differ from the revision's: {changed}")
        [metadata] = [name for name in names if name.endswith(".dist-info/METADATA")]
        version = email.parser.Parser().parsestr(wheel.read(metadata).decode())["Version"]
    expected = tomllib.loads((checkout / "pyproject.toml").read_text())["project"]["version"]
    if version != expected or version != manifest["version"]:
        raise SystemExit(f"the wheel is version {version}; the revision declares {expected}.")
    print(f"{manifest['wheel']} holds {manifest['repository']} at {rev}: {len(packaged)} files agree.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["update", "check"])
    parser.add_argument("checkout", type=Path, help="a jev-ultrafast git checkout")
    args = parser.parse_args()
    (update if args.command == "update" else check)(args.checkout.resolve())


if __name__ == "__main__":
    main()
