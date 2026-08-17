// Fixture: expect/actual declarations. A real project splits these across
// source sets; for lexing purposes both live in this one file.

expect fun platformName(): String

actual fun platformName(): String = "jvm"

expect val cacheSize: Int

actual val cacheSize: Int = 64
