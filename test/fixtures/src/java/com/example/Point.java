package com.example;

/** Fixture record with a compact constructor. */
public record Point(int x, int y) {

    /** Compact constructor rejecting negative coordinates. */
    public Point {
        if (x < 0 || y < 0) {
            throw new IllegalArgumentException("negative coordinate");
        }
    }
}
