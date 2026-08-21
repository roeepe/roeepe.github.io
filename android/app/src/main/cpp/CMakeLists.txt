cmake_minimum_required(VERSION 3.22)
project(ivritwhisper C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include(FetchContent)

# whisper.cpp is pulled in at configure time rather than vendored, so this repo
# stays a static site with one Android folder in it. Pinned to a tag: an
# unpinned build would silently change what the app runs.
set(BUILD_SHARED_LIBS        OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS      OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES   OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER     OFF CACHE BOOL "" FORCE)
set(WHISPER_ALL_WARNINGS     OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL             OFF CACHE BOOL "" FORCE)
# The NDK ships no OpenMP runtime, and cross-compiling rules out -march=native.
set(GGML_OPENMP              OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE              OFF CACHE BOOL "" FORCE)
set(GGML_CCACHE              OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_TESTS         OFF CACHE BOOL "" FORCE)
set(GGML_BUILD_EXAMPLES      OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    whispercpp
    GIT_REPOSITORY https://github.com/ggml-org/whisper.cpp.git
    GIT_TAG        v1.9.1
    GIT_SHALLOW    TRUE
)
FetchContent_MakeAvailable(whispercpp)

add_library(ivritwhisper SHARED whisper_jni.cpp)

target_link_libraries(ivritwhisper PRIVATE whisper log android)
