PAIRS = [(1000, "M"), (500, "D"), (100, "C"), (50, "L"), (10, "X"), (5, "V"), (1, "I")]


def run(text):
    n = int(text)
    out = ""
    for value, letters in PAIRS:
        while n >= value:
            out += letters
            n -= value
    return out
