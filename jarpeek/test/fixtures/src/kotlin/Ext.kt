// Fixture: top-level extensions — they land in the ExtKt facade as members
// carrying receiverType.

fun String.shout(): String {
    return uppercase() + "!"
}

inline fun <reified T> List<T>.firstOfType(): T? {
    for (item in this) {
        if (item is T) return item
    }
    return null
}

val List<Int>.sumOrZero: Int
    get() = if (isEmpty()) 0 else sum()
