"""WebAuthn helpers for ES256 passkeys.

This is intentionally narrow: nia-todo supports platform/browser passkeys with
ES256/P-256, user verification required, attestation conveyance "none", RP-ID
pinning, challenge binding, signature verification and sign-counter rollback
checks in the router.
"""

from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass
from urllib.parse import urlparse

from errors import api_error
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import hashes

from services.instance_config import get_instance_config

LOCAL_RP_IDS = {"localhost", "127.0.0.1", "::1"}
ANDROID_PACKAGE_NAME = "de.tobiaskneidl.nia_todo"
ANDROID_RELEASE_CERT_SHA256 = "90:0E:26:CD:40:B8:BF:42:A6:5B:98:02:8A:A5:43:9F:6A:72:74:15:55:FE:26:C4:85:B8:34:E3:B1:97:E0:58"
ANDROID_PASSKEY_ORIGINS = {"android:apk-key-hash:kA4mzUC4v0KmW5gCiqVDn2pydBVV_ibEhbg047GX4Fg"}


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode((value or "") + "=" * ((4 - len(value or "") % 4) % 4))


class CborReader:
    def __init__(self, data: bytes):
        self.data = data
        self.i = 0

    def read(self):
        initial = self._byte()
        major = initial >> 5
        add = initial & 0x1F
        n = self._arg(add)
        if major == 0:
            return n
        if major == 1:
            return -1 - n
        if major == 2:
            return self._bytes(n)
        if major == 3:
            return self._bytes(n).decode()
        if major == 4:
            return [self.read() for _ in range(n)]
        if major == 5:
            return {self.read(): self.read() for _ in range(n)}
        if major == 7:
            if add == 20:
                return False
            if add == 21:
                return True
            if add == 22:
                return None
        raise ValueError(f"Unsupported CBOR item major={major} add={add}")

    def _byte(self) -> int:
        if self.i >= len(self.data):
            raise ValueError("Unexpected end of CBOR")
        b = self.data[self.i]
        self.i += 1
        return b

    def _bytes(self, n: int) -> bytes:
        if self.i + n > len(self.data):
            raise ValueError("Unexpected end of CBOR bytes")
        b = self.data[self.i:self.i + n]
        self.i += n
        return b

    def _arg(self, add: int) -> int:
        if add < 24:
            return add
        if add == 24:
            return self._byte()
        if add == 25:
            return int.from_bytes(self._bytes(2), "big")
        if add == 26:
            return int.from_bytes(self._bytes(4), "big")
        if add == 27:
            return int.from_bytes(self._bytes(8), "big")
        raise ValueError("Indefinite CBOR not supported")


def cbor_loads(data: bytes):
    reader = CborReader(data)
    value = reader.read()
    if reader.i != len(data):
        raise ValueError("Trailing CBOR data")
    return value


@dataclass
class AttestedCredential:
    credential_id: bytes
    cose_key: dict
    sign_count: int


@dataclass
class WebAuthnRelyingParty:
    rp_id: str
    origin: str


def rp_id_hash(rp_id: str) -> bytes:
    return hashlib.sha256(rp_id.encode()).digest()


def relying_party_for_request(request) -> WebAuthnRelyingParty:
    """Return pinned WebAuthn RP settings.

    Production passkeys should be bound to the configured public_base_url. Local
    development is allowed to fall back to localhost. Browser/WebView origins
    such as tauri.localhost are rejected; native apps must use the OS passkey
    bridge with the server-provided RP origin.
    """
    config = get_instance_config()
    public_base_url = (config.get("public_base_url") or "").rstrip("/")
    if public_base_url:
        parsed = urlparse(public_base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise api_error(400, "passkey.publicBaseUrlInvalid", "Public base URL is invalid for passkeys")
        hostname = parsed.hostname.lower()
        if parsed.scheme != "https" and hostname not in LOCAL_RP_IDS:
            raise api_error(400, "passkey.publicBaseUrlHttpsRequired", "Passkeys require HTTPS for the public base URL")
        origin = f"{parsed.scheme}://{parsed.netloc}"
        return WebAuthnRelyingParty(rp_id=hostname, origin=origin)

    parsed_request = urlparse(str(request.url))
    host = (parsed_request.hostname or "").lower()
    if host == "tauri.localhost":
        raise api_error(400, "passkey.nativeBridgeRequired", "Native apps need the native passkey bridge first")
    if host not in LOCAL_RP_IDS:
        raise api_error(400, "passkey.publicBaseUrlRequired", "Passkeys require a configured public base URL")
    return WebAuthnRelyingParty(rp_id=host, origin=f"{parsed_request.scheme}://{parsed_request.netloc}")


def allowed_webauthn_origins(expected_origin: str) -> set[str]:
    origins = {expected_origin}
    origins.update(ANDROID_PASSKEY_ORIGINS)
    return origins


def verify_client_data(client_data_json: bytes, expected_type: str, expected_challenge: str, expected_origin: str) -> dict:
    data = json.loads(client_data_json.decode())
    if data.get("type") != expected_type:
        raise ValueError("Unexpected WebAuthn clientData type")
    if data.get("challenge") != expected_challenge:
        raise ValueError("WebAuthn challenge mismatch")
    if data.get("origin") not in allowed_webauthn_origins(expected_origin):
        raise ValueError("WebAuthn origin mismatch")
    if data.get("crossOrigin") is True:
        raise ValueError("Cross-origin WebAuthn ceremony rejected")
    return data


def parse_auth_data(auth_data: bytes, expected_rp_id: str, require_attested: bool = False, require_user_verified: bool = False):
    if len(auth_data) < 37:
        raise ValueError("Authenticator data too short")
    if auth_data[:32] != rp_id_hash(expected_rp_id):
        raise ValueError("RP ID hash mismatch")
    flags = auth_data[32]
    if not (flags & 0x01):
        raise ValueError("User presence flag missing")
    if require_user_verified and not (flags & 0x04):
        raise ValueError("User verification flag missing")
    sign_count = int.from_bytes(auth_data[33:37], "big")
    if not require_attested:
        return {"flags": flags, "sign_count": sign_count}
    if not (flags & 0x40):
        raise ValueError("Attested credential data missing")
    offset = 37 + 16
    if len(auth_data) < offset + 2:
        raise ValueError("Credential length missing")
    cred_len = int.from_bytes(auth_data[offset:offset + 2], "big")
    offset += 2
    if cred_len <= 0 or len(auth_data) < offset + cred_len:
        raise ValueError("Invalid credential id length")
    credential_id = auth_data[offset:offset + cred_len]
    offset += cred_len
    cose_key = cbor_loads(auth_data[offset:])
    return AttestedCredential(credential_id=credential_id, cose_key=cose_key, sign_count=sign_count)


def parse_none_attestation(attestation_object: bytes, expected_rp_id: str) -> AttestedCredential:
    attestation = cbor_loads(attestation_object)
    if not isinstance(attestation, dict):
        raise ValueError("Invalid attestation object")
    if attestation.get("fmt") != "none":
        raise ValueError("Only none attestation is accepted")
    if attestation.get("attStmt") not in ({}, None):
        raise ValueError("Unexpected attestation statement")
    auth_data = attestation.get("authData")
    if not isinstance(auth_data, (bytes, bytearray)):
        raise ValueError("Authenticator data missing")
    return parse_auth_data(bytes(auth_data), expected_rp_id, require_attested=True, require_user_verified=True)


def public_key_from_cose(cose_key: dict):
    # ES256 public key: kty=EC2(2), alg=ES256(-7), crv=P-256(1), x=-2, y=-3
    if cose_key.get(1) != 2 or cose_key.get(3) != -7 or cose_key.get(-1) != 1:
        raise ValueError("Only ES256/P-256 passkeys are supported")
    x_bytes = cose_key.get(-2)
    y_bytes = cose_key.get(-3)
    if not isinstance(x_bytes, bytes) or not isinstance(y_bytes, bytes) or len(x_bytes) != 32 or len(y_bytes) != 32:
        raise ValueError("Invalid P-256 public key coordinates")
    x = int.from_bytes(x_bytes, "big")
    y = int.from_bytes(y_bytes, "big")
    return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()


def cose_to_json(cose_key: dict) -> str:
    return json.dumps({str(k): b64url_encode(v) if isinstance(v, bytes) else v for k, v in cose_key.items()})


def cose_from_json(value: str) -> dict:
    raw = json.loads(value)
    result = {}
    for k, v in raw.items():
        ik = int(k)
        result[ik] = b64url_decode(v) if ik in (-2, -3) else v
    return result


def verify_assertion_signature(public_key_json: str, auth_data: bytes, client_data_json: bytes, signature: bytes) -> None:
    public_key = public_key_from_cose(cose_from_json(public_key_json))
    signed = auth_data + hashlib.sha256(client_data_json).digest()
    try:
        public_key.verify(signature, signed, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as exc:
        raise ValueError("Invalid WebAuthn signature") from exc
