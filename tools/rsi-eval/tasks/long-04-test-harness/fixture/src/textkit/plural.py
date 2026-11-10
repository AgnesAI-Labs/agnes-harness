def run(word):
    if word.endswith(("s", "x", "ch", "sh")):
        return word + "es"
    return word + "s"
