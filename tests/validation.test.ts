import test from "node:test";
import assert from "node:assert/strict";
import { validateAvatarUpload, validateUpload } from "../src/lib/data.ts";
import { isImage, previewOf } from "../src/lib/format.ts";
import { isSecretBody } from "../src/lib/secret.ts";

function fakeFile(name: string, type: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type });
}

test("validateUpload and validateAvatarUpload block SVG, HTML, JS, executables, and empty files", () => {
  assert.ok(validateUpload(fakeFile("payload.svg", "image/svg+xml")));
  assert.ok(validateUpload(fakeFile("exploit.html", "text/html")));
  assert.ok(validateUpload(fakeFile("script.js", "application/javascript")));
  assert.ok(validateUpload(fakeFile("empty.png", "image/png", 0)));
  assert.equal(validateUpload(fakeFile("photo.png", "image/png")), null);
  assert.equal(validateUpload(fakeFile("encrypted.enc", "application/octet-stream")), null);

  assert.ok(validateAvatarUpload(fakeFile("avatar.svg", "image/svg+xml")));
  assert.ok(validateAvatarUpload(fakeFile("avatar.pdf", "application/pdf")));
  assert.equal(validateAvatarUpload(fakeFile("avatar.webp", "image/webp")), null);
});

test("isImage blocks SVG and previewOf recognizes both v1 and v2 E2EE envelopes", () => {
  assert.equal(isImage("image/svg+xml", "bad.svg"), false);
  assert.equal(isImage("image/png", "ok.png"), true);
  assert.equal(previewOf("luma:e2ee:v1:abc", false), "🔒 Encrypted message");
  assert.equal(previewOf("luma:e2ee:v2:xyz", false), "🔒 Encrypted message");
  assert.equal(isSecretBody("luma:e2ee:v2:xyz"), true);
  assert.equal(isSecretBody("luma:e2ee:v1:abc"), true);
  assert.equal(isSecretBody("hello"), false);
});
