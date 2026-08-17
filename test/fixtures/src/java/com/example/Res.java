package com.example;

/** Fixture annotation type with a defaulted member. */
public @interface Res {

    /** The resource path this annotation names. */
    String value() default "";
}
