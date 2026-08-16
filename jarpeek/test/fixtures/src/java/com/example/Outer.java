package com.example;

/** Fixture with an anonymous class, a lambda, and a nested class. */
public class Outer {

    /** Builds two runners: one anonymous class, one lambda. */
    public void dispatch(String task) {
        Runnable anonymous = new Runnable() {
            @Override
            public void run() {
                System.out.println("anonymous:" + task);
            }
        };
        Runnable lambda = () -> System.out.println("lambda:" + task);
        anonymous.run();
        lambda.run();
    }

    /** Nested class with its own public method. */
    public class Inner {

        /** Returns the inner label. */
        public String describe() {
            return "inner";
        }
    }
}
