"""Check release identity and versions without calling a model or changing files."""

import argparse
import json
import re
import tomllib
from pathlib import Path

PACKAGE = "@weichen96/dsh-browser-use"
REPOSITORY = "git+https://github.com/ricardochen1996/dsh-browser-use.git"
REGISTRY = "https://registry.npmjs.org/"


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Git tag being released, such as v0.1.1")
    args = parser.parse_args()
    try:
        version = check_release(Path(__file__).resolve().parent.parent, args.tag)
    except ValueError as error:
        parser.exit(1, f"Release refused: {error}\n")
    print(f"Release identity and versions agree: {PACKAGE}@{version}")


if __name__ == "__main__":
    main()
