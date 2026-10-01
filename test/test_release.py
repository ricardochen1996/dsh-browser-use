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


WHEEL = "jev_ultrafast-0.1.0-py3-none-any.whl"
REV = "6bfef1d73475432ce31b0b58a5e136acef20602e"


@pytest.fixture
def engine(root):
    vendor = root / "vendor"
    vendor.mkdir()
    (vendor / WHEEL).write_bytes(b"wheel")
    digest = release.hashlib.sha256(b"wheel").hexdigest()
    (vendor / "jev-ultrafast.json").write_text(json.dumps({"rev": REV, "version": "0.1.0", "wheel": WHEEL}))
    (root / "pyproject.toml").write_text(
        '[project]\nname = "sidecar"\nversion = "0.1.1"\n'
        f'[tool.uv.sources]\njev-ultrafast = {{ path = "vendor/{WHEEL}" }}\n'
    )
    (root / "uv.lock").write_text(
        '[[package]]\nname = "sidecar"\nversion = "0.1.1"\n\n'
        f'[[package]]\nname = "jev-ultrafast"\nversion = "0.1.0"\nsource = {{ path = "vendor/{WHEEL}" }}\n'
        f'wheels = [{{ filename = "{WHEEL}", hash = "sha256:{digest}" }}]\n'
    )
    package = json.loads((root / "package.json").read_text())
    package["files"] = ["lib/", "vendor/*.whl", "vendor/jev-ultrafast.json"]
    (root / "package.json").write_text(json.dumps(package))
    return root


def test_bundled_engine_agrees(engine):
    assert release.check_release(engine) == "0.1.1"
    assert release.check_engine(engine)["rev"] == REV


def test_engine_shipped_by_directory_entry(engine):
    package = json.loads((engine / "package.json").read_text())
    package["files"] = ["lib/", "vendor"]
    (engine / "package.json").write_text(json.dumps(package))
    assert release.check_engine(engine)["wheel"] == WHEEL


def edit_manifest(root, **changes):
    path = root / "vendor" / "jev-ultrafast.json"
    path.write_text(json.dumps({**json.loads(path.read_text()), **changes}))


@pytest.mark.parametrize("change,match", [
    (lambda root: (root / "vendor" / "jev-ultrafast.json").unlink(), "missing"),
    (lambda root: edit_manifest(root, rev="main"), "revision"),
    (lambda root: edit_manifest(root, rev=REV[:12]), "revision"),
    (lambda root: edit_manifest(root, version="0.2.0"), "is not"),
    (lambda root: edit_manifest(root, wheel="jev_ultrafast-0.1.1-py3-none-any.whl"), "exactly"),
    (lambda root: (root / "vendor" / "jev_ultrafast-0.0.9-py3-none-any.whl").write_bytes(b"old"), "exactly"),
    (lambda root: (root / "vendor" / WHEEL).write_bytes(b"rebuilt"), "uv.lock"),
    (lambda root: (root / "pyproject.toml").write_text(
        '[project]\nname = "sidecar"\nversion = "0.1.1"\n'
        '[tool.uv.sources]\njev-ultrafast = { git = "https://github.com/ricardochen1996/jev-ultrafast" }\n'
    ), "pyproject"),
    (lambda root: (root / "package.json").write_text(json.dumps({
        **json.loads((root / "package.json").read_text()), "files": ["lib/", "vendor/jev-ultrafast.json"],
    })), "files"),
])
def test_engine_drift_is_refused(engine, change, match):
    change(engine)
    with pytest.raises(ValueError, match=match):
        release.check_engine(engine)
