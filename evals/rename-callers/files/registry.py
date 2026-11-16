import importlib

COMMANDS = {"total": "orders.calc"}


def run(command, *args):
    module_name, func_name = COMMANDS[command].rsplit(".", 1)
    return getattr(importlib.import_module(module_name), func_name)(*args)
