# DiVault Android

Minimal Android WebView client for `com.divault.mobile`. It connects to an existing DiVault server and uses that server for login, uploads, and sync.

## Open

Open the `android/` directory in Android Studio and let Gradle sync with Android Gradle Plugin 8.7.3. Use Android Studio's bundled JDK 17 or newer.

## Server URL

When the app asks for a DiVault server URL, enter the same server address you use for DiVault in the browser or desktop client, such as `https://notes.example.com`.

The app stores that URL on the device. Use `Clear server URL` to switch to another server.

## Uploads And Sync

File uploads are sent to the configured DiVault server. Sync uses that same DiVault server URL, so changing the URL changes both uploads and sync. The Android app does not create a separate local vault.
