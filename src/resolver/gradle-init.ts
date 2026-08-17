/**
 * The Gradle init script jarpeek injects to ask a build for its resolved
 * dependency artifacts.
 *
 * Invoked as `gradle -I .jarpeek/gradle-init.gradle --console=plain -q
 * jarpeekDump`: the script registers one task `jarpeekDump` on the root
 * project (never per-subproject); running it prints a single JSON document
 * between sentinel lines on stdout —
 *
 *   ###JARPEEK-BEGIN###
 *   {"configurations":[{"name":"compileClasspath","dependencies":[
 *     {"coordinates":"g:a:v","kind":"external","path":"/abs/file.jar"},
 *     {"coordinates":":app","kind":"module","path":"/abs/project/dir"}]}],
 *    "sources":{"g:a:v":"/abs/sources.jar"}}
 *   ###JARPEEK-END###
 *
 * Collection rules, mirrored by the parser in `gradle.ts`:
 * - configurations come from the root project and every subproject, matched
 *   by name against a fixed set (absent names are skipped);
 * - resolution is lenient per configuration: a failure becomes an "error"
 *   field on that configuration instead of aborting the dump;
 * - external components (g:a:v) report their artifact file; project
 *   components report the project directory;
 * - the sources pass resolves one detached configuration per external
 *   coordinate of the compile/runtime configurations with classifier
 *   "sources"; coordinates without a sources jar are omitted.
 *
 * No Gradle distribution exists on the development machine: the script is
 * exercised end-to-end only by the gated e2e test, so it stays defensive
 * (Gradle >= 7 API surface, per-configuration try/catch, `println` output
 * that survives `--console=plain -q`).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// NOTE: the script lives in a template literal; the Groovy interpolation in
// the coordinates GString is escaped (\${) so JavaScript does not evaluate it.
// Any unescaped ${ ... } would throw a ReferenceError at module load.
export const GRADLE_INIT_SCRIPT = `// jarpeek init script: dumps resolved dependency artifacts as sentinel-wrapped JSON.
// Registered by jarpeek's Gradle resolver; see src/resolver/gradle-init.ts for the contract.

import groovy.json.JsonOutput
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.artifacts.component.ProjectComponentIdentifier

def CONFIG_NAMES = [
        'compileClasspath',
        'runtimeClasspath',
        'testCompileClasspath',
        'testRuntimeClasspath',
        'annotationProcessor',
        'kapt',
        'kaptTest',
        'compileOnly',
        'testCompileOnly',
]

// Consumer-side label for a configuration name (kapt* is Kotlin's annotation
// processor configuration). Mirrored by configurationLabel in gradle.ts.
def configLabel = { String name ->
    if (name.startsWith('kapt') || name.contains('annotationProcessor')) {
        return 'annotationProcessor'
    }
    if (name.contains('test')) {
        return 'test'
    }
    if (name.contains('compile')) {
        return 'compile'
    }
    if (name.contains('runtime')) {
        return 'runtime'
    }
    return 'compile'
}

// Resolved artifacts of a configuration. ArtifactCollection.resolvedArtifacts
// exists from Gradle 7.4; older 7.x falls back to direct iteration.
def collectArtifacts = { configuration ->
    def artifacts = configuration.incoming.artifacts
    if (artifacts.hasProperty('resolvedArtifacts') != null) {
        return artifacts.resolvedArtifacts.get()
    }
    return artifacts as List
}

gradle.projectsLoaded {
    def rootProject = it.rootProject
    if (rootProject.tasks.findByName('jarpeekDump') != null) {
        return
    }
    rootProject.tasks.register('jarpeekDump') { task ->
        task.group = 'jarpeek'
        task.description = 'Dumps resolved dependency artifacts as sentinel-wrapped JSON for jarpeek'
        task.doLast {
            def configurationsOut = []
            def sourceCoordinates = [] as Set

            rootProject.allprojects.each { project ->
                CONFIG_NAMES.each { configName ->
                    def configuration = project.configurations.findByName(configName)
                    if (configuration == null) {
                        return
                    }
                    def dependenciesOut = []
                    def seen = [] as Set
                    try {
                        collectArtifacts(configuration).each { artifact ->
                            def file = artifact.file
                            if (file == null) {
                                return
                            }
                            def identifier = artifact.id.componentIdentifier
                            if (identifier instanceof ModuleComponentIdentifier) {
                                def coordinates = "\${identifier.group}:\${identifier.module}:\${identifier.version}".toString()
                                if (seen.contains(coordinates)) {
                                    return
                                }
                                seen.add(coordinates)
                                dependenciesOut.add([coordinates: coordinates, kind: 'external', path: file.absolutePath])
                                def label = configLabel(configName)
                                if (label == 'compile' || label == 'runtime') {
                                    sourceCoordinates.add(coordinates)
                                }
                            } else if (identifier instanceof ProjectComponentIdentifier) {
                                if (seen.contains(identifier.projectPath)) {
                                    return
                                }
                                seen.add(identifier.projectPath)
                                def dependencyProject = rootProject.findProject(identifier.projectPath)
                                def directory = dependencyProject != null ? dependencyProject.projectDir : file.parentFile
                                dependenciesOut.add([coordinates: identifier.projectPath, kind: 'module', path: directory.absolutePath])
                            }
                        }
                        configurationsOut.add([name: configName, dependencies: dependenciesOut])
                    } catch (Exception failure) {
                        // null or empty message would render as "null"/"" — name the class instead
                        def failureMessage = failure.message ?: failure.getClass().getName()
                        configurationsOut.add([name: configName, error: String.valueOf(failureMessage)])
                    }
                }
            }

            def sourcesOut = [:]
            sourceCoordinates.each { coordinates ->
                try {
                    def parts = coordinates.split(':')
                    def dependency = rootProject.dependencies.create([
                            group     : parts[0],
                            name      : parts[1],
                            version   : parts[2],
                            classifier: 'sources',
                    ])
                    def detached = rootProject.configurations.detachedConfiguration(dependency)
                    collectArtifacts(detached).each { artifact ->
                        if (artifact.id.componentIdentifier instanceof ModuleComponentIdentifier && artifact.file != null) {
                            sourcesOut[coordinates] = artifact.file.absolutePath
                        }
                    }
                } catch (Exception ignored) {
                    // no sources jar for this coordinate: omitted from the dump
                }
            }

            println '###JARPEEK-BEGIN###'
            println JsonOutput.toJson([configurations: configurationsOut, sources: sourcesOut])
            println '###JARPEEK-END###'
        }
    }
}
`;

/**
 * Materialize the init script at `<projectRoot>/.jarpeek/gradle-init.gradle`,
 * returning its path. Idempotent: when the file already holds exactly
 * `GRADLE_INIT_SCRIPT` nothing is rewritten (mtime preserved), so repeated
 * resolutions never dirty the project.
 */
export async function ensureGradleInitScript(projectRoot: string): Promise<string> {
  const scriptPath = join(projectRoot, ".jarpeek", "gradle-init.gradle");
  await mkdir(join(projectRoot, ".jarpeek"), { recursive: true });

  let existing: string | undefined;
  try {
    existing = await readFile(scriptPath, "utf8");
  } catch {
    // absent: fall through and write it
  }
  if (existing !== GRADLE_INIT_SCRIPT) {
    await writeFile(scriptPath, GRADLE_INIT_SCRIPT, "utf8");
  }
  return scriptPath;
}
