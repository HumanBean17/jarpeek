package com.example;

import java.util.List;

/**
 * Demo fixture class for the jarpeek lexer golden tests. It exercises
 * javadoc, overloads, fields, deprecation, and nesting.
 */
public class Demo {

    private static final String NAME = "demo";

    /**
     * Runs the demo transformation over the given input.
     *
     * @param input the raw input text
     * @param count how many passes to apply
     * @return the transformed result
     * @throws Exception if the transformation fails
     */
    public Object run(String input, int count) throws Exception {
        return NAME + ":" + input + ":" + count;
    }

    /** Overload with no arguments, kept package-private on purpose. */
    void run() {
        try {
            Object result = run("none", 0);
            System.out.println(result);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * Old entry point kept for compatibility.
     *
     * @deprecated use {@link #run(String, int)} instead
     */
    @Deprecated
    void old() {
        run();
    }

    /** Nested worker used by {@link Demo#run(String, int)}. */
    public static class Worker {

        /** Performs one unit of work and reports its cost. */
        protected int work() {
            return 1;
        }
    }
}
