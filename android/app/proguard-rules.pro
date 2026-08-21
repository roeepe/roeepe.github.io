# The JNI layer calls back into these by name, so they must survive shrinking.
-keep class io.github.roeepe.ivrit.engine.WhisperNative { *; }
-keep interface io.github.roeepe.ivrit.engine.WhisperCallback { *; }
-keep class io.github.roeepe.ivrit.engine.WhisperSegment { *; }
