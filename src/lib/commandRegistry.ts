import Config from "../config"

// The command registry, in its own module so instrumentation (metrics)
// and tests can register/execute commands without pulling in
// ags/gtk4/app (which runs Gtk.init() at import and needs a display).
// requestHandler.ts registers the app-dependent "quit" command.

type CommandResponse = string | Promise<string>

type NameList<T> = [T, ...T[]]
interface CommandEntry {
    /** Commands name */
    name: NameList<string>
    /** Subcommands */
    subCommands?: string[]
    /** Short description for help */
    description?: string
    /** Longer help for command specific help*/
    help?: string
    /** Main function that runs when command is executed */
    main: (args: string[]) => CommandResponse
}

/**
 * gpt made this, modified a bunch and updated to work with newer style arguments.
 */
class CommandRegistry {
    static instance: CommandRegistry

    static get_default() {
        if (!this.instance) this.instance = new CommandRegistry()

        return this.instance
    }
    private commands: CommandEntry[] = []

    /** Register a command */
    register(command: CommandEntry): void {
        command.name.forEach(element => {
            if (element.includes(" "))
                throw new Error(`Invalid altName "${element}" — spaces are not allowed`)
        })

        if (command.name.length === 0)
            throw new Error(`Command must have at least 1 name ${command}`)

        // execute() picks the first matching entry, so a re-registered
        // alias would silently shadow the new command — call it out
        const taken = new Set(this.commands.flatMap(c => c.name.map(n => n.toLowerCase())))
        const dupes = command.name.filter(n => taken.has(n.toLowerCase()))
        if (dupes.length > 0)
            console.warn(
                `Request: "${command.name[0]}" alias(es) already registered and will be shadowed: ${dupes.join(", ")}`,
            )

        this.commands.push(command)
    }

    /**
     * Executes the given command while passing arguments to the command
     * @param argv command + arguments for command
     * @returns Returns the executed commands output string
     */
    async execute(argv: string[], silent: boolean = false): Promise<string> {
        // copy + split: call sites pass fixed lists (["notifications"],
        // ...) whose first element shift() would eat, and `ags request
        // -i x "cmd arg"` delivers the whole string as one element.
        // Note quotes are NOT honored: an argument that genuinely
        // contains spaces would be split — no current command takes one.
        const args = argv.flatMap(a => a.split(/\s+/).filter(Boolean))
        let requested_command = args.shift()

        if (requested_command === undefined) return "<helper> help for list of commands"

        if (!silent) {
            console.log(`Request: command(${requested_command}) args(${args.join(", ")})`)
        }

        // Typescript happy, Also sane default
        if (!requested_command) {
            requested_command = "help"
        }

        const entry = this.commands.find(cmd =>
            cmd.name.some(name => name.toLowerCase() === requested_command.toLowerCase()),
        )

        if (!entry) {
            return `Unknown request: ${requested_command}. Type "help" for a list of commands.`
        }

        try {
            const result = await entry.main(args)
            return `${Config.instanceName}: ${result}`
        } catch (err) {
            console.warn(`Request error: ${(err as Error).message}`)
            return `${Config.instanceName} Error: ${(err as Error).message}`
        }
    }

    /**
     * Every registered command, in registration order.
     *
     * The launcher's palette renders this — which is the point of every
     * entry carrying a `description`. Until now the only reader was
     * `help`, which formats them into a wall of text for a terminal; the
     * same list is what makes the shell's own commands searchable from
     * inside the shell.
     *
     * A copy, not the live array: a caller iterating this must not be
     * able to reorder or drop the registry's own entries.
     */
    list(): { name: string; aliases: string[]; description: string }[] {
        return this.commands.map(cmd => ({
            name: cmd.name[0],
            aliases: [...cmd.name],
            description: cmd.description ?? "",
        }))
    }

    help(argv: string[]): string {
        const command = argv.shift()
        if (command) {
            const entry = this.commands.find(cmd =>
                cmd.name.some(name => name.toLowerCase() === command.toLowerCase()),
            )
            if (entry?.help) {
                let out = `${entry.name[0]}:\n`
                out += entry.help
                return out
            } else if (entry) {
                return `Command "${entry.name[0]}" has no help, ;(`
            } else {
                return `No such command "${command}"`
            }
        }

        let out = "Available commands:\n"
        for (const cmd of this.commands) {
            out += `\n- ${cmd.name[0]}\n`
            out += `  ${cmd.description}\n\n`
            out += `  Aliases: ${cmd.name.join(", ")}\n`
            if (cmd.subCommands) out += `  subcommands: ${cmd.subCommands.join(", ")}\n`
        }
        return out.trim()
    }

    constructor() {
        this.register({
            name: ["help", "commands", "?"],
            description: "Lists all registered commands",
            help: `List commands and gives help to commands
          - help
            Lists all registered commands
          - help <command>
            gives help to command if command has a help section
        `,
            main: (argv: string[]) => this.help(argv),
        })
    }
}

export default CommandRegistry
