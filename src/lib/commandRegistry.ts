import Config from "../config";

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
        if (!this.instance)
            this.instance = new CommandRegistry()

        return this.instance
    }
    private commands: CommandEntry[] = []

    /** Register a command */
    register(command: CommandEntry): void {
        command.name.forEach(element => {
            if (element.includes(" "))
                throw new Error(`Invalid altName "${element}" — spaces are not allowed`);
        });

        if (command.name.length === 0)
            throw new Error(`Command must have at least 1 name ${command}`)

        this.commands.push(command)
    }

    /**
     * Executes the given command while passing arguments to the command
     * @param argv command + arguments for command
     * @returns Returns the executed commands output string
     */
    async execute(argv: string[], silent: boolean = false): Promise<string> {
        // `ags request -i x "cmd arg"` delivers the whole string as one
        // element; split so quoted and unquoted forms behave the same
        argv = argv.flatMap(a => a.split(/\s+/).filter(Boolean))
        let requested_command = argv.shift()

        if (requested_command === undefined) return "<helper> help for list of commands"

        if (!silent) {
            console.log(`Request: command(${requested_command}) args(${argv.join(", ")})`)
        }

        // Typescript happy, Also sane default
        if (!requested_command) {
            requested_command = "help"
        }

        const entry = this.commands.find(cmd =>
            cmd.name.some(name => name.toLowerCase() === requested_command.toLowerCase())
        )

        if (!entry) {
            return `Unknown request: ${requested_command}. Type "help" for a list of commands.`
        }

        try {
            const result = await entry.main(argv)
            return `${Config.instanceName}: ${result}`
        } catch (err) {
            console.warn(`Request error: ${(err as Error).message}`)
            return `${Config.instanceName} Error: ${(err as Error).message}`
        }
    }

    help(argv: string[]): string {
        const command = argv.shift()
        if (command) {
            const entry = this.commands.find(cmd =>
                cmd.name.some(name => name.toLowerCase() === command.toLowerCase())
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
            if (cmd.subCommands)
                out += `  subcommands: ${cmd.subCommands.join(", ")}\n`
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
            main: (argv: string[]) => this.help(argv)
        })
    }
}

export default CommandRegistry
