# Function Selector GUI Application

A PySide6-based GUI application that allows users to select and run different functions from separate Python files.

## Features

- Left panel displays a list of available functions
- Right panel shows the selected function's interface
- Dynamic loading of function modules
- Easy to add new functions

## Requirements

- Python 3.6 or higher
- PySide6

## Installation

1. Clone the repository:
```bash
git clone [repository-url]
cd [repository-name]
```

2. Install the required packages:
```bash
pip install -r requirements.txt
```

## Usage

1. Run the main application:
```bash
python main.py
```

2. To add new functions:
   - Create a new Python file in the `functions` directory
   - Implement a `get_widget()` function that returns a PySide6 widget
   - The function will automatically appear in the left panel

## Project Structure

```
.
├── main.py              # Main application file
├── requirements.txt     # Project dependencies
├── functions/          # Directory containing function modules
│   └── example_function.py  # Example function module
└── README.md           # This file
```

## Adding New Functions

Each function file should follow this template:

```python
def get_widget():
    from PySide6.QtWidgets import QWidget, QVBoxLayout
    widget = QWidget()
    layout = QVBoxLayout(widget)
    # Add your widgets to the layout
    return widget
```

## License

[Your chosen license] 