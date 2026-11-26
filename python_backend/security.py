"""Cryptographic helpers for TRAX LINK Python backend (scrypt, HMAC, authenticated encryption, voucher tokens)."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
import uuid

from .config import get_env

VOUCHER_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
_EPHEMERAL_KEY: bytes | None = None


def _get_encryption_key() -> bytes:
    global _EPHEMERAL_KEY
    configured = get_env("ROUTER_ENCRYPTION_KEY")
    if len(configured) >= 16:
        return hashlib.sha256(configured.encode("utf-8")).digest()
    if _EPHEMERAL_KEY is None:
        seed = get_env("APP_URL") or "netco-dev-fallback-key"
        _EPHEMERAL_KEY = hashlib.sha256(seed.encode("utf-8")).digest()
    return _EPHEMERAL_KEY


def generate_id(prefix: str = "") -> str:
    raw = uuid.uuid4().hex[:16]
    return f"{prefix}_{raw}" if prefix else raw


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def hash_password(password: str) -> str:
    """Hash password using scrypt format compatible with Node crypto.scryptSync."""
    salt = secrets.token_hex(16)
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16384,
        r=8,
        p=1,
        dklen=64,
    ).hex()
    return f"scrypt:{salt}:{derived}"


def verify_password(password: str, stored_hash: str) -> bool:
    parts = stored_hash.split(":")
    if len(parts) != 3 or parts[0] != "scrypt":
        return False
    _, salt, hex_digest = parts
    try:
        expected = bytes.fromhex(hex_digest)
    except ValueError:
        return False
    derived = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16384,
        r=8,
        p=1,
        dklen=64,
    )
    if len(derived) != len(expected):
        return False
    return hmac.compare_digest(derived, expected)


def _derive_keystream(enc_key: bytes, nonce: bytes, length: int) -> bytes:
    chunks: list[bytes] = []
    counter = 0
    total = 0
    while total < length:
        block = hashlib.sha256(enc_key + nonce + counter.to_bytes(4, "big")).digest()
        chunks.append(block)
        total += len(block)
        counter += 1
    return b"".join(chunks)[:length]


def encrypt_secret(plaintext: str) -> str:
    """Authenticated encryption (SHA-256 CTR + HMAC-SHA256) in pure Python stdlib."""
    master = _get_encryption_key()
    enc_key = hashlib.sha256(b"enc:" + master).digest()
    mac_key = hashlib.sha256(b"mac:" + master).digest()
    nonce = secrets.token_bytes(16)
    data = plaintext.encode("utf-8")
    stream = _derive_keystream(enc_key, nonce, len(data))
    ct = bytes(a ^ b for a, b in zip(data, stream))
    tag = hmac.new(mac_key, nonce + ct, hashlib.sha256).digest()
    return f"py1:{nonce.hex()}:{tag.hex()}:{ct.hex()}"


def decrypt_secret(ciphertext: str) -> str:
    parts = ciphertext.split(":")
    if len(parts) == 4 and parts[0] == "py1":
        _, nonce_hex, tag_hex, ct_hex = parts
        nonce = bytes.fromhex(nonce_hex)
        tag = bytes.fromhex(tag_hex)
        ct = bytes.fromhex(ct_hex)
        master = _get_encryption_key()
        enc_key = hashlib.sha256(b"enc:" + master).digest()
        mac_key = hashlib.sha256(b"mac:" + master).digest()
        expected_tag = hmac.new(mac_key, nonce + ct, hashlib.sha256).digest()
        if not hmac.compare_digest(tag, expected_tag):
            raise ValueError("Encrypted secret integrity check failed")
        stream = _derive_keystream(enc_key, nonce, len(ct))
        pt = bytes(a ^ b for a, b in zip(ct, stream))
        return pt.decode("utf-8")
    raise ValueError("Unsupported encrypted secret format")


def generate_voucher_code() -> str:
    chars = "".join(
        VOUCHER_ALPHABET[b % len(VOUCHER_ALPHABET)] for b in secrets.token_bytes(8)
    )
    return f"NTC-{chars[:4]}-{chars[4:8]}"


def normalize_voucher_code(code: str) -> str:
    return "".join(code.strip().upper().split())


def mask_voucher_code(code: str) -> str:
    norm = normalize_voucher_code(code)
    if len(norm) <= 8:
        return f"{norm[:4]}****"
    return f"{norm[:8]}-****"


def _base36_now() -> str:
    num = int(time.time() * 1000)
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    out: list[str] = []
    while num:
        num, rem = divmod(num, 36)
        out.append(alphabet[rem])
    return "".join(reversed(out)) or "0"


def generate_reference(prefix: str) -> str:
    rand = secrets.token_hex(4).upper()
    return f"{prefix}-{_base36_now()}-{rand}"


def generate_session_token() -> str:
    return secrets.token_hex(32)
