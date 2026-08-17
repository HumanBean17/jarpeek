// Fixture: top-level declarations compile into the file facade class FacadeKt.
// No package on purpose — the facade fqn is then the bare "FacadeKt".

/** Simple top-level function. */
fun alpha() {
    println("alpha")
}

val threshold: Int = 10

fun greet(name: String = "x, y)") {
    println(name)
}

fun `when`() {
    // keyword used as an identifier via backticks
}

fun banner(): String = """
    } brace and the word fun inside a raw string; none of it is code
    template ${1 + 1} too
""".trimIndent()

val afterBanner: Int = 1
