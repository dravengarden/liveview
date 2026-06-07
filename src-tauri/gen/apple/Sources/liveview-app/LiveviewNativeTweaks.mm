// Native-layer tweaks for the liveview WKWebView shell. These are the whole
// point of wrapping the web UI in Tauri: things a pure-web PWA on iOS cannot do.
//
// Compiled into the app (xcodegen includes everything under Sources/); the
// C constructors run once at image load, before any WebView exists.
//
// NOTE: this file lives in the generated gen/apple tree but is hand-authored and
// committed. If you ever re-run `cargo tauri ios init`, confirm it survived
// (init leaves extra Sources/*.mm alone — see src-tauri/README.md gotchas).
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>

// (1) THE reason this shell exists: background / lock-screen audiobook playback.
//
// A WKWebView shares the app's AVAudioSession. By default that session is in a
// category that the OS silences the moment the app backgrounds, so a pure-web
// PWA's <audio> stops when the screen locks. Putting the session in the
// Playback category — paired with the `audio` UIBackgroundMode in
// Info.ios.plist — tells iOS this app plays primary audio that should continue
// in the background, and lets the MediaSession API the web app already drives
// surface on the lock screen / Control Center.
//
// SpokenAudio mode is the audiobook-appropriate variant (it interacts correctly
// with other spoken-audio apps / CarPlay). We set the category but DON'T force
// the session active here — the web layer activates it when playback actually
// starts (avoids ducking other apps while liveview is only being read).
__attribute__((constructor)) static void liveviewConfigureAudioSession(void) {
    @autoreleasepool {
        AVAudioSession *session = [AVAudioSession sharedInstance];
        NSError *err = nil;
        [session setCategory:AVAudioSessionCategoryPlayback
                        mode:AVAudioSessionModeSpokenAudio
                     options:0
                       error:&err];
        if (err) {
            NSLog(@"[liveview] AVAudioSession setCategory failed: %@", err);
        }
    }
}

// (2) Remove the iOS keyboard accessory bar (the ∧ ∨ + Done strip above the
// keyboard) — it can't be removed from a pure-web PWA, only by a native
// WKWebView owner making the private WKContentView return a nil
// inputAccessoryView. liveview's only text input is the shelf search box, so the
// bar is pure noise there.
__attribute__((constructor)) static void liveviewStripKeyboardAccessoryBar(void) {
    @autoreleasepool {
        Class cls = NSClassFromString(@"WKContentView");
        if (!cls) {
            return;
        }
        SEL sel = @selector(inputAccessoryView);
        IMP nilImp = imp_implementationWithBlock(^id(id _self) { return nil; });

        Method existing = class_getInstanceMethod(cls, sel);
        const char *types = existing ? method_getTypeEncoding(existing) : "@@:";

        // class_addMethod adds an override ONLY on WKContentView when the method
        // is inherited; it returns NO when WKContentView already defines its own,
        // in which case we replace that own implementation. Either way we never
        // touch a shared superclass implementation.
        if (!class_addMethod(cls, sel, nilImp, types)) {
            method_setImplementation(class_getInstanceMethod(cls, sel), nilImp);
        }
    }
}
