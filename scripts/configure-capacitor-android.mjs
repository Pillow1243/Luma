/** Apply Luma permissions, icons and invite links after `cap add android`. */
import fs from "node:fs";
import path from "node:path";
const android = path.resolve("android/app/src/main");
const manifestPath = path.join(android, "AndroidManifest.xml");
let manifest = fs.readFileSync(manifestPath, "utf8");
for (const permission of ["CAMERA", "RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS"]) {
  const declaration = `<uses-permission android:name="android.permission.${permission}" />`;
  if (!manifest.includes(declaration)) manifest = manifest.replace("</manifest>", `    ${declaration}\n</manifest>`);
}
if (!manifest.includes("android:pathPrefix=\"/join/\"")) {
  const deepLink = `\n            <intent-filter>\n                <action android:name="android.intent.action.VIEW" />\n                <category android:name="android.intent.category.DEFAULT" />\n                <category android:name="android.intent.category.BROWSABLE" />\n                <data android:scheme="https" android:host="luma-messenger-chi.vercel.app" android:pathPrefix="/join/" />\n            </intent-filter>\n`;
  manifest = manifest.replace("        </activity>", `${deepLink}        </activity>`);
}
fs.writeFileSync(manifestPath, manifest);
const java = path.join(android, "java/app/luma/messenger/MainActivity.java");
fs.mkdirSync(path.dirname(java), { recursive: true });
fs.writeFileSync(java, `package app.luma.messenger;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import org.json.JSONObject;
public class MainActivity extends BridgeActivity {
  @Override public void onCreate(Bundle state) { super.onCreate(state); routeInvite(getIntent()); }
  @Override public void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); routeInvite(intent); }
  private void routeInvite(Intent intent) {
    if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
    Uri uri = intent.getData();
    if (uri == null || !"https".equals(uri.getScheme()) || !"luma-messenger-chi.vercel.app".equals(uri.getHost())) return;
    String path = uri.getPath();
    if (path == null || !path.matches("/join/[a-zA-Z0-9-]+")) return;
    String script = "window.location.hash = " + JSONObject.quote("#" + path);
    getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript(script, null), 1200);
  }
}
`);
const resources = path.resolve("mobile/apk-shell/res");
for (const entry of fs.readdirSync(resources)) {
  if (entry.startsWith("mipmap-")) fs.cpSync(path.join(resources, entry), path.join(android, "res", entry), { recursive: true });
}
const colors = path.join(android, "res/values/luma_colors.xml");
fs.writeFileSync(colors, '<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="luma_ink">#0B0716</color></resources>\n');
const gradle = path.resolve("android/app/build.gradle");
let build = fs.readFileSync(gradle, "utf8");
build = build.replace(/versionCode\s+\d+/, "versionCode 3").replace(/versionName\s+\"[^\"]+\"/, 'versionName "2.1.0-debug"');
fs.writeFileSync(gradle, build);
console.log("Configured Capacitor Android permissions, branding and invite links.");
