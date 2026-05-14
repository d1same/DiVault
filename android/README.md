# DiVault Android

Android client for `com.divault.mobile`. It is a fullscreen WebView wrapper for an existing DiVault server, so Android uses the same synced notes as your browser and desktop clients.

## Open

Open the `android/` directory in Android Studio and let Gradle sync with Android Gradle Plugin 8.7.3. Use Android Studio's bundled JDK 17 or newer.

## Server URL

On first launch, enter the same server address you use for DiVault in the browser or desktop client, such as `https://notes.example.com`.

The app stores that URL on the device. If the saved server is unavailable, the retry screen lets you retry or change the saved server URL.

## Uploads And Sync

File uploads, notes, login, and sync all happen through the configured DiVault server. Changing the saved URL changes the server the Android app uses.

The Android app is online-first. Use the browser PWA cache for limited offline viewing, but create/edit workflows should be treated as server-backed.

## Sharing Into DiVault

Android share intents can send text into DiVault after you are signed in to the configured server.

## Release Signing

GitHub release builds publish `DiVault_*_android-signed.apk`, signed with the project release keystore stored in GitHub Actions secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

If a device has an older debug APK installed, Android may reject the signed APK update because the certificates differ. Uninstall the debug APK once, then install the signed APK. Future signed APK versions should update normally.
