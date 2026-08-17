package com.example

// Fixture: classes only — no top-level fun/val, so no file facade.

data class User(val name: String, val age: Int)

interface Repo {
    suspend fun load(id: Long): User?
}

class Impl : Repo {
    override suspend fun load(id: Long): User? = null

    companion object {
        val default: Impl = Impl()
    }
}

enum class Color {
    RED, GREEN, BLUE;
}

object Singleton {
    val ready: Boolean = true

    fun reset() {
        // no-op
    }
}

class Account(val id: Long, var balance: Long) {
    var locked: Boolean = false
        get() = field

    init {
        require(id > 0)
    }

    constructor(id: Long) : this(id, 0L)

    fun deposit(amount: Long): Long {
        balance += amount
        return balance
    }
}
