"""Check release identity and versions without calling a model or changing files."""

import argparse
import fnmatch
import hashlib
import json
import re
import tomllib
from pathlib import Path

PACKAGE = "@ricardochen1996/dsh-browser-use"
REPOSITORY = "git+https://github.com/ricardochen1996/dsh-browser-use.git"
REGISTRY = "https://registry.npmjs.org/"
ENGINE = "jev-ultrafast"
ENGINE_MANIFEST = "vendor/jev-ultrafast.json"


def check_release(root, tag=None):
    package = json.loads((root / "package.json").read_text())
    project = tomllib.loads((root / "pyproject.toml").read_text())["project"]
    lock = tomllib.loads((root / "uv.lock").read_text())
    version = package["version"]
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)", version):
        raise ValueError("This release workflow accepts stable x.y.z versions only.")
    if package["name"] != PACKAGE or package.get("private"):
        raise ValueError(f"The release must be a publishable {PACKAGE} package.")
    if package.get("repository", {}).get("url") != REPOSITORY:
        raise ValueError("repository.url must match the npm trusted publisher's GitHub repository.")
    publish = package.get("publishConfig", {})
    if publish.get("access") != "public" or publish.get("registry") != REGISTRY:
        raise ValueError("publishConfig must select public access on registry.npmjs.org.")
    if project["version"] != version:
        raise ValueError("package.json and pyproject.toml versions differ; run uv version VERSION --no-sync.")
    locked = [item for item in lock["package"] if item["name"] == project["name"]]
    if len(locked) != 1 or locked[0]["version"] != version:
        raise ValueError("uv.lock has a different sidecar version; run uv lock.")
    if tag is not None and tag != f"v{version}":
        raise ValueError(f"Tag {tag!r} must be v{version}.")
    return version


def check_engine(root):
    """The engine the plugin installs: one wheel, named by its manifest, pinned by the lock, shipped by npm."""
    try:
        manifest = json.loads((root / ENGINE_MANIFEST).read_text())
    except FileNotFoundError:
        raise ValueError(f"{ENGINE_MANIFEST} is missing; run bin/vendor_engine.py update <checkout>.") from None
    if not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("rev", ""))):
        raise ValueError(f"{ENGINE_MANIFEST} must name the full git revision the wheel was built from.")
    wheel = str(manifest.get("wheel", ""))
    version = str(manifest.get("version", ""))
    wheels = sorted(path.name for path in (root / "vendor").glob("*.whl"))
    if wheels != [wheel]:
        raise ValueError(f"vendor/ must hold exactly the wheel {ENGINE_MANIFEST} names ({wheel}), not {wheels}.")
    if not wheel.startswith(f"jev_ultrafast-{version}-"):
        raise ValueError(f"{wheel} is not {ENGINE} {version}.")
    source = f"vendor/{wheel}"
    sources = tomllib.loads((root / "pyproject.toml").read_text()).get("tool", {}).get("uv", {}).get("sources", {})
    if sources.get(ENGINE) != {"path": source}:
        raise ValueError(f"pyproject.toml must take {ENGINE} from {source}.")
    digest = "sha256:" + hashlib.sha256((root / source).read_bytes()).hexdigest()
    locked = [item for item in tomllib.loads((root / "uv.lock").read_text())["package"] if item["name"] == ENGINE]
    if (
        len(locked) != 1
        or locked[0].get("source") != {"path": source}
        or locked[0].get("version") != version
        or [item.get("hash") for item in locked[0].get("wheels", [])] != [digest]
    ):
        raise ValueError(f"uv.lock does not pin {source} as it is; run uv lock.")
    files = json.loads((root / "package.json").read_text()).get("files", [])
    for path in (source, ENGINE_MANIFEST):
        if not any(
            fnmatch.fnmatchcase(path, pattern) or path.startswith(pattern.rstrip("/") + "/") for pattern in files
        ):
            raise ValueError(f"package.json files must ship {path}.")
    return manifest


def check_requirements(root):
    """The pip-installable half of the lock: rendered from uv.lock, shipped, and deliberately pillow-free.

    `vendor/requirements.txt` is what builds the environment on a machine that has a Python 3.12+ and
    no uv, so it has to agree with the lock it is rendered from, and it has to travel in the tarball.
    """
    try:
        import vendor_requirements
    except ImportError:
        raise ValueError("bin/vendor_requirements.py is missing; it renders vendor/requirements.txt.") from None
    path = root / "vendor" / "requirements.txt"
    if not path.exists():
        raise ValueError("vendor/requirements.txt is missing; run bin/vendor_requirements.py update.")
    text = path.read_text()
    if text != vendor_requirements.render(root):
        raise ValueError("vendor/requirements.txt no longer matches uv.lock; run bin/vendor_requirements.py update.")
    locked = {item["name"]: item for item in tomllib.loads((root / "uv.lock").read_text())["package"]}
    if "pillow" not in locked:
        raise ValueError("the lock no longer carries pillow; drop the exclusion from bin/vendor_requirements.py.")
    if any(line.startswith("pillow==") for line in text.splitlines()):
        raise ValueError(
            "vendor/requirements.txt must not pin pillow: this plugin never calls the helpers that use it."
        )
    for line in text.splitlines():
        pinned = re.match(r"^([A-Za-z0-9._-]+)==([^\s]+)", line)
        if pinned is None:
            continue
        name, pinned_version = pinned.groups()
        if name not in locked:
            raise ValueError(f"vendor/requirements.txt pins {name}, which uv.lock does not carry.")
        if pinned_version != locked[name]["version"]:
            raise ValueError(
                f"vendor/requirements.txt pins {name} {pinned_version}, not the lock's {locked[name]['version']}."
            )
    files = json.loads((root / "package.json").read_text()).get("files", [])
    if not any(fnmatch.fnmatchcase("vendor/requirements.txt", pattern) for pattern in files):
        raise ValueError("package.json files must ship vendor/requirements.txt.")
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Git tag being released, such as v0.1.1")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    try:
        version = check_release(root, args.tag)
        engine = check_engine(root)
        requirements = check_requirements(root)
    except ValueError as error:
        parser.exit(1, f"Release refused: {error}\n")
    print(f"Release identity and versions agree: {PACKAGE}@{version}")
    print(f"Bundled engine agrees: {ENGINE} {engine['version']} from {engine['rev'][:12]} ({engine['wheel']})")
    print(f"Pip requirements agree: {requirements.count('==')} packages pinned by hash from uv.lock, pillow skipped")


if __name__ == "__main__":
    main()
