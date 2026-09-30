"""Release gates must fail before npm is allowed to publish."""

import importlib.util
import json
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "check_release", Path(__file__).resolve().parent.parent / "bin" / "check_release.py",
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


@pytest.fixture
def root(tmp_path):
    package = {
        "name": release.PACKAGE, "version": "0.1.1",
        "repository": {"url": release.REPOSITORY},
        "publishConfig": {"access": "public", "registry": release.REGISTRY},
    }
    (tmp_path / "package.json").write_text(json.dumps(package))
    (tmp_path / "pyproject.toml").write_text('[project]\nname = "sidecar"\nversion = "0.1.1"\n')
    (tmp_path / "uv.lock").write_text('[[package]]\nname = "sidecar"\nversion = "0.1.1"\n')
    return tmp_path


def test_matching_release_versions_and_tag(root):
    assert release.check_release(root) == "0.1.1"
    assert release.check_release(root, "v0.1.1") == "0.1.1"


@pytest.mark.parametrize("tag", ["0.1.1", "v0.1.0", "main", "v0.1.1-rc.1"])
def test_wrong_release_tag_is_refused(root, tag):
    with pytest.raises(ValueError, match="Tag"):
        release.check_release(root, tag)


@pytest.mark.parametrize("path", ["pyproject.toml", "uv.lock"])
def test_python_version_drift_is_refused(root, path):
    file = root / path
    file.write_text(file.read_text().replace("0.1.1", "0.1.0"))
    with pytest.raises(ValueError, match="version"):
        release.check_release(root)


@pytest.mark.parametrize("key,value", [
    ("version", "0.1.1-rc.1"),
    ("name", "@rc/dsh-browser-use"),
    ("private", True),
    ("publishConfig", {"access": "restricted", "registry": release.REGISTRY}),
    ("repository", {"url": "git+https://github.com/example/fork.git"}),
])
def test_invalid_publish_metadata_is_refused(root, key, value):
    path = root / "package.json"
    package = json.loads(path.read_text())
    package[key] = value
    path.write_text(json.dumps(package))
    with pytest.raises(ValueError):
        release.check_release(root)
