# Windows Code Signing

DiVault's release workflow signs Windows installers when a real code-signing certificate is available in GitHub Actions secrets.

## Required Secrets

- `WINDOWS_CERT_BASE64`: base64-encoded `.pfx` code-signing certificate
- `WINDOWS_CERT_PASSWORD`: password for the `.pfx` certificate

## Create The Base64 Secret

From PowerShell, convert your `.pfx` certificate to a single-line base64 value:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\certificate.pfx")) | Set-Clipboard
```

Paste the clipboard value into the `WINDOWS_CERT_BASE64` repository secret.

## Certificate Notes

- EV certificates are the best way to reduce Microsoft SmartScreen warnings quickly.
- OV certificates sign the installer, but SmartScreen reputation can still take time to build.
- Without these secrets, release builds intentionally upload unsigned installers.
