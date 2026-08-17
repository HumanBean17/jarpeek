package com.example;

/** Fixture enum with one method. */
public enum Colors {
    RED,
    GREEN,
    BLUE;

    /** Returns a lowercase label for the constant. */
    public String label() {
        return name().toLowerCase();
    }
}
