const { readFileSync } = require('fs') as { readFileSync(path: string, encoding: string): string };
const { resolve } = require('path') as { resolve(...parts: string[]): string };
const read = (path: string) => readFileSync(resolve(__dirname, '..', '..', path), 'utf8');
export {};

describe('secure background transport contract', () => {
  it('protects the exported receiver with a signature permission', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:name="com.yunote.permission.LOCAL_TRANSPORT"');
    expect(manifest).toContain('android:protectionLevel="signature"');
    expect(manifest).toContain('android:name=".transport.YunoteTransportReceiver"');
    expect(manifest).toContain('android:permission="com.yunote.permission.LOCAL_TRANSPORT"');
    expect(manifest).toContain('<package android:name="com.iotkeyfobplatform.app" />');
  });

  it('runs messages as a headless JS task while the UI is closed', () => {
    const receiver = read('android/app/src/main/java/com/com.yunote.app/transport/YunoteTransportReceiver.kt');
    const service = read('android/app/src/main/java/com/com.yunote.app/transport/YunoteTransportService.kt');
    const index = read('index.js');
    expect(receiver).toContain('HeadlessJsTaskService.acquireWakeLockNow');
    expect(service).toContain('HeadlessJsTaskConfig(');
    expect(index).toContain("registerHeadlessTask('YunoteTransportTask'");
  });
});
