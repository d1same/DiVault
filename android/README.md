# DiVault Android

Android client for `com.divault.mobile`. It supports a standalone local vault on-device and an optional server-connected WebView mode for syncing with an existing DiVault server.

## Open

Open the `android/` directory in Android Studio and let Gradle sync with Android Gradle Plugin 8.7.3. Use Android Studio's bundled JDK 17 or newer.

## Local Vault

The app opens the local vault by default. Local notes are stored on the Android device, can be searched and edited offline, and can be exported/imported as JSON.

Export local notes before uninstalling the app, switching phones, or clearing app data. Android removes local app storage during uninstall.

## Server URL

Tap `Server` and enter the same server address you use for DiVault in the browser or desktop client, such as `https://notes.example.com`.

The app stores that URL on the device. Tap `Server` again to switch to another server. Tap `Local` to return to the standalone local vault.

## Uploads And Sync

In server mode, file uploads are sent to the configured DiVault server. Sync uses that same DiVault server URL, so changing the URL changes both uploads and sync.

The standalone local vault does not automatically sync with the server. Use JSON export/import for local backups, or use server mode when you need shared data across devices.

## Release Signing

GitHub release builds publish `DiVault_*_android-signed.apk`, signed with the project release keystore stored in GitHub Actions secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

If a device has an older debug APK installed, Android may reject the signed APK update because the certificates differ. Export local notes, uninstall the debug APK once, then install the signed APK. Future signed APK versions should update normally.
