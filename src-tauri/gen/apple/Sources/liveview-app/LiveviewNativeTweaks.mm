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
#import <MediaPlayer/MediaPlayer.h>
#import <WebKit/WebKit.h>
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

// (3) Edge-swipe back/forward. WKWebView ships with
// `allowsBackForwardNavigationGestures` OFF, but Safari / a standalone PWA have
// it ON — which is why swiping from the screen edge to go "back" worked as a web
// app but stopped in the native shell. liveview routes entirely via the History
// API (pushState/popstate), so re-enabling the gesture navigates that SAME
// history — purely native, zero web change, the PWA is untouched. Swizzle
// WKWebView's designated initializer so EVERY instance (Tauri's webview
// included) gets it on; the constructor runs at image load, before any webview
// is created.
static id (*lv_orig_wk_init)(id, SEL, CGRect, id) = NULL;
static id lv_wk_init(id self, SEL _cmd, CGRect frame, id configuration) {
    id wv = lv_orig_wk_init(self, _cmd, frame, configuration);
    if (wv) {
        ((WKWebView *)wv).allowsBackForwardNavigationGestures = YES;
    }
    return wv;
}

__attribute__((constructor)) static void liveviewEnableSwipeBack(void) {
    @autoreleasepool {
        Method m = class_getInstanceMethod(
            [WKWebView class], @selector(initWithFrame:configuration:));
        if (m) {
            lv_orig_wk_init =
                (id (*)(id, SEL, CGRect, id))method_getImplementation(m);
            method_setImplementation(m, (IMP)lv_wk_init);
        }
    }
}

// (4) Lock-screen skip interval = 15s (iOS-only, native shell only). The system
// draws the lock-screen / Control Center skip buttons from the shared
// MPRemoteCommandCenter; the number is each skip command's `preferredIntervals`.
// WebKit drives these for WKWebView media but leaves the interval at the system
// default (10s) — a pure web app / PWA can't touch it. The native host CAN:
// proactively SET preferredIntervals to [15] on the shared command center, and
// re-assert on a light timer (WebKit reconfigures the command center on each
// play/pause/load, which can reset it). The button then reads 15 and a tap fires
// a 15s skip (honoured by liveview's MediaSession seekOffset handler). The PWA is
// untouched — native-only. MediaPlayer.framework is linked (project.yml).
static void lv_applySkip15(void) {
    MPRemoteCommandCenter *cc = [MPRemoteCommandCenter sharedCommandCenter];
    cc.skipForwardCommand.preferredIntervals = @[ @15 ];
    cc.skipBackwardCommand.preferredIntervals = @[ @15 ];
}

__attribute__((constructor)) static void liveviewForceSkip15(void) {
    // Defer to the main run loop (the constructor runs before it exists), then
    // pin the interval and keep re-asserting it.
    dispatch_async(dispatch_get_main_queue(), ^{
        lv_applySkip15();
        [NSTimer scheduledTimerWithTimeInterval:1.5
                                        repeats:YES
                                          block:^(NSTimer *_Nonnull timer) {
                                            (void)timer;
                                            lv_applySkip15();
                                          }];
    });
}
