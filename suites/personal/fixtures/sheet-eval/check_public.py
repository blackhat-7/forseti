from sheet import evaluate

book = {
    "Budget": {
        "A1": "120", "A2": "80.5", "A3": "=SUM(A1:A2)", "A4": "=A3/2",
        "B1": "rent", "B2": '=CONCAT(B1, ": ", A1)', "B3": "=IF(A1>100, \"high\", \"low\")",
    },
    "Notes": {"A1": "=Budget!A4*2"},
}
result = evaluate(book)
assert result == {
    "Budget": {"A1": "120", "A2": "80.5", "A3": "200.5", "A4": "100.25",
               "B1": "rent", "B2": "rent: 120", "B3": "high"},
    "Notes": {"A1": "200.5"},
}, result
print("public check passed")
