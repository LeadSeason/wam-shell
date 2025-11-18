import app from "ags/gtk4/app";
import Config from "../config";

// Example usage at the bottom of the page

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
    async execute(argv: string[]): Promise<string> {
        let requested_command = argv.shift()
        console.log("Request:", requested_command)
        console.log("args:", argv.join(", "))

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
}

const registry = CommandRegistry.get_default()

// requestHandler, Pass this to app.start()
export async function requestHandler(argv: string[], res: (response: string) => void) {
    res(await registry.execute(argv))
}

// register the help command
registry.register({
    name: ["help", "commands", "?"],
    description: "Lists all registered commands",
    help: `List commands and gives help to commands
  - help
    Lists all registered commands
  - help <command>
    gives help to command if command has a help section
`,
    main: (argv: string[]) => registry.help(argv)
})

registry.register({
    name: ["quit", "exit"],
    description: "quit Application",
    help: `Exits the app`,
    main: () => {
        app.quit(0);
        return "exiting ..."
    }
})

export default CommandRegistry