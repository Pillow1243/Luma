#!/usr/bin/env python3
"""Create the Luma release signing keystore (PKCS#12, RSA 2048, 30 years).

Implemented with `openssl` + Python's `cryptography`-free stdlib so it runs in
minimal containers. The resulting key signs both v1/v2/v3 APK signature schemes
and is pinned in the repo so every future Luma APK upgrades cleanly in place.

Usage:  python3 scripts/make-keystore.py [--force]
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "mobile" / "keystore" / "luma-release.keystore"
PASS = os.environ.get("LUMA_KEYSTORE_PASS")
if not PASS:
    sys.exit("LUMA_KEYSTORE_PASS is not set — refusing to generate a keystore with a default password.")
ALIAS = os.environ.get("LUMA_KEY_ALIAS", "luma")
DNAME = (
    "/C=US/ST=District of Columbia/L=Washington/O=Luma/OU=Messenger"
    "/CN=Luma/emailAddress=hello@luma.app"
)


def run(cmd: list[str], **kw) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, **kw)


def main() -> None:
    if OUT.exists() and "--force" not in sys.argv:
        print(f"keystore already exists: {OUT.relative_to(ROOT)} (use --force to regenerate)")
        return
    if not shutil.which("openssl"):
        sys.exit("openssl is required to generate the signing key")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    key = OUT.parent / "luma-release.key"
    crt = OUT.parent / "luma-release.crt"
    p12 = OUT.parent / "luma-release.p12"

    for f in (key, crt, p12, OUT):
        f.unlink(missing_ok=True)

    run(["openssl", "genrsa", "-out", str(key), "2048"])
    run([
        "openssl", "req", "-new", "-x509", "-days", "10950",
        "-key", str(key), "-out", str(crt), "-subj", DNAME,
        "-sha256",
    ])
    run([
        "openssl", "pkcs12", "-export", "-inkey", str(key), "-in", str(crt),
        "-out", str(p12), "-name", ALIAS, "-passout", f"pass:{PASS}",
    ])
    # keytool (from any JDK) converts PKCS#12 → JKS, which apksigner reads
    # natively and is what Android tooling expects.
    keytool = None
    for cand in (
        os.environ.get("KEYTOOL"),
        "/tmp/venv/lib/python3.11/site-packages/jdk4py/java-runtime/bin/keytool",
    ):
        if cand and Path(cand).exists():
            keytool = cand
            break
    if keytool:
        run([
            keytool, "-importkeystore", "-noprompt",
            "-srckeystore", str(p12), "-srcstoretype", "PKCS12",
            "-srcstorepass", PASS, "-srcalias", ALIAS,
            "-destkeystore", str(OUT), "-deststoretype", "JKS",
            "-deststorepass", PASS, "-destkeypass", PASS, "-destalias", ALIAS,
        ])
    else:
        OUT.write_bytes(p12.read_bytes())

    key.unlink(missing_ok=True)
    crt.unlink(missing_ok=True)
    p12.unlink(missing_ok=True)

    digest = hashlib.sha256(OUT.read_bytes()).hexdigest()[:32]
    print(f"keystore written: {OUT.relative_to(ROOT)}")
    print(f"  alias    {ALIAS}")
    print(f"  storepass {PASS}")
    print(f"  sha256   {digest}")
    print("  (keep this file safe — it signs every Luma release)")


if __name__ == "__main__":
    main()
