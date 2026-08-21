// JNI bridge to whisper.cpp.
//
// Deliberately thin: it owns the whisper_context lifetime, pumps segments back
// to Kotlin as they are produced, and lets Kotlin abort a run mid-decode. Every
// other decision — chunking, resampling, retries — lives in Kotlin where it can
// be read and changed without a native rebuild.

#include <jni.h>
#include <android/log.h>

#include <string>
#include <vector>

#include "whisper.h"

#define LOG_TAG "ivrit-whisper"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

// Everything the callbacks need while whisper_full() is running.
struct CallbackBridge {
    JNIEnv *  env;
    jobject   listener;
    jmethodID onSegment;    // (double,double,String) -> void
    jmethodID onProgress;   // (int) -> void
    jmethodID isCancelled;  // () -> boolean
    int       emitted;      // how many segments have already been handed over
    double    offsetSec;    // absolute position of this chunk in the recording
};

std::string jstringToStd(JNIEnv *env, jstring s) {
    if (s == nullptr) return {};
    const char *chars = env->GetStringUTFChars(s, nullptr);
    std::string out(chars ? chars : "");
    if (chars) env->ReleaseStringUTFChars(s, chars);
    return out;
}

void newSegmentCallback(struct whisper_context *ctx, struct whisper_state * /*state*/,
                        int n_new, void *user_data) {
    auto *b = static_cast<CallbackBridge *>(user_data);
    if (b == nullptr || b->env == nullptr) return;

    const int total = whisper_full_n_segments(ctx);
    for (int i = total - n_new; i < total; ++i) {
        if (i < b->emitted) continue;
        // whisper reports centiseconds.
        const double t0 = whisper_full_get_segment_t0(ctx, i) / 100.0 + b->offsetSec;
        const double t1 = whisper_full_get_segment_t1(ctx, i) / 100.0 + b->offsetSec;
        const char *text = whisper_full_get_segment_text(ctx, i);

        jstring jtext = b->env->NewStringUTF(text ? text : "");
        b->env->CallVoidMethod(b->listener, b->onSegment, t0, t1, jtext);
        b->env->DeleteLocalRef(jtext);
        if (b->env->ExceptionCheck()) { b->env->ExceptionClear(); return; }
        b->emitted = i + 1;
    }
}

void progressCallback(struct whisper_context * /*ctx*/, struct whisper_state * /*state*/,
                      int progress, void *user_data) {
    auto *b = static_cast<CallbackBridge *>(user_data);
    if (b == nullptr || b->env == nullptr) return;
    b->env->CallVoidMethod(b->listener, b->onProgress, progress);
    if (b->env->ExceptionCheck()) b->env->ExceptionClear();
}

// Returning true tells whisper.cpp to stop. This is the only place a long
// decode can be interrupted, so cancellation latency is one decode step.
bool abortCallback(void *user_data) {
    auto *b = static_cast<CallbackBridge *>(user_data);
    if (b == nullptr || b->env == nullptr) return false;
    jboolean cancelled = b->env->CallBooleanMethod(b->listener, b->isCancelled);
    if (b->env->ExceptionCheck()) { b->env->ExceptionClear(); return true; }
    return cancelled == JNI_TRUE;
}

} // namespace

extern "C" {

JNIEXPORT jstring JNICALL
Java_io_github_roeepe_ivrit_engine_WhisperNative_systemInfo(JNIEnv *env, jobject) {
    return env->NewStringUTF(whisper_print_system_info());
}

JNIEXPORT jstring JNICALL
Java_io_github_roeepe_ivrit_engine_WhisperNative_benchMatmul(JNIEnv *env, jobject, jint threads) {
    const char *s = whisper_bench_ggml_mul_mat_str(threads);
    return env->NewStringUTF(s ? s : "");
}

JNIEXPORT jlong JNICALL
Java_io_github_roeepe_ivrit_engine_WhisperNative_initContext(JNIEnv *env, jobject,
                                                             jstring modelPath, jboolean useGpu) {
    const std::string path = jstringToStd(env, modelPath);
    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu     = useGpu == JNI_TRUE;
    cparams.flash_attn  = false;

    whisper_context *ctx = whisper_init_from_file_with_params(path.c_str(), cparams);
    if (ctx == nullptr) {
        LOGE("failed to load model from %s", path.c_str());
        return 0;
    }
    LOGI("model loaded: %s (gpu=%d)", path.c_str(), cparams.use_gpu);
    return reinterpret_cast<jlong>(ctx);
}

JNIEXPORT void JNICALL
Java_io_github_roeepe_ivrit_engine_WhisperNative_freeContext(JNIEnv *, jobject, jlong handle) {
    if (handle == 0) return;
    whisper_free(reinterpret_cast<whisper_context *>(handle));
}

/**
 * Runs one chunk of audio. Returns 0 on success, the whisper_full() error code
 * otherwise, and -99 if the context handle was invalid.
 */
JNIEXPORT jint JNICALL
Java_io_github_roeepe_ivrit_engine_WhisperNative_transcribe(
        JNIEnv *env, jobject,
        jlong handle, jfloatArray pcm, jstring language,
        jint threads, jint beamSize, jdouble offsetSec,
        jboolean translate, jstring initialPrompt, jobject listener) {

    if (handle == 0) return -99;
    auto *ctx = reinterpret_cast<whisper_context *>(handle);

    const jsize n = env->GetArrayLength(pcm);
    jfloat *samples = env->GetFloatArrayElements(pcm, nullptr);
    if (samples == nullptr) return -98;

    const std::string lang   = jstringToStd(env, language);
    const std::string prompt = jstringToStd(env, initialPrompt);

    jclass cls = env->GetObjectClass(listener);
    CallbackBridge bridge{};
    bridge.env         = env;
    bridge.listener    = listener;
    bridge.onSegment   = env->GetMethodID(cls, "onSegment", "(DDLjava/lang/String;)V");
    bridge.onProgress  = env->GetMethodID(cls, "onProgress", "(I)V");
    bridge.isCancelled = env->GetMethodID(cls, "isCancelled", "()Z");
    bridge.emitted     = 0;
    bridge.offsetSec   = offsetSec;

    if (bridge.onSegment == nullptr || bridge.onProgress == nullptr || bridge.isCancelled == nullptr) {
        env->ReleaseFloatArrayElements(pcm, samples, JNI_ABORT);
        return -97;
    }

    whisper_full_params params = whisper_full_default_params(
            beamSize > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);

    params.n_threads        = threads > 0 ? threads : 4;
    params.language         = lang.empty() ? "he" : lang.c_str();
    params.detect_language  = false;
    params.translate        = translate == JNI_TRUE;
    params.print_realtime   = false;
    params.print_progress   = false;
    params.print_timestamps = false;
    params.print_special    = false;
    params.no_timestamps    = false;
    params.single_segment   = false;
    params.suppress_blank   = true;
    // whisper.cpp's name for "do not feed the previous transcript back in as a
    // prompt". A wrong guess early on otherwise conditions everything after it,
    // which on Hebrew audio tends to spiral rather than recover.
    params.no_context = true;
    if (!prompt.empty()) params.initial_prompt = prompt.c_str();
    if (beamSize > 1) params.beam_search.beam_size = beamSize;

    params.new_segment_callback           = newSegmentCallback;
    params.new_segment_callback_user_data = &bridge;
    params.progress_callback              = progressCallback;
    params.progress_callback_user_data    = &bridge;
    params.abort_callback                 = abortCallback;
    params.abort_callback_user_data       = &bridge;

    const int rc = whisper_full(ctx, params, samples, static_cast<int>(n));

    env->ReleaseFloatArrayElements(pcm, samples, JNI_ABORT);
    return rc;
}

} // extern "C"
