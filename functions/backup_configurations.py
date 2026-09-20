import os
import pandas as pd
from netmiko import ConnectHandler
from netmiko.ssh_dispatcher import CLASS_MAPPER_BASE
from PySide6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QPushButton,
                             QLabel, QLineEdit, QComboBox, QTableWidget,
                             QTableWidgetItem, QFileDialog, QMessageBox,
                             QHeaderView, QProgressBar, QCheckBox, QGroupBox,
                             QScrollArea, QFormLayout, QDialog, QTextEdit)
from PySide6.QtCore import Qt, QThread, Signal
import shutil
from datetime import datetime

class CommandDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Add New Command")
        self.setup_ui()
        
    def setup_ui(self):
        layout = QFormLayout(self)
        
        self.command_input = QLineEdit()
        self.brand_combo = QComboBox()
        self.type_input = QLineEdit()
        
        # Add device types from netmiko to combo box
        device_types = sorted(CLASS_MAPPER_BASE.keys())
        self.brand_combo.addItems(device_types)
        
        layout.addRow("Command:", self.command_input)
        layout.addRow("Device Type:", self.brand_combo)
        layout.addRow("Type:", self.type_input)
        
        buttons = QHBoxLayout()
        save_button = QPushButton("Save")
        save_button.clicked.connect(self.accept)
        cancel_button = QPushButton("Cancel")
        cancel_button.clicked.connect(self.reject)
        
        buttons.addWidget(save_button)
        buttons.addWidget(cancel_button)
        layout.addRow(buttons)

class OutputDialog(QDialog):
    def __init__(self, site, command, output, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"Command Output - {site}")
        self.setMinimumSize(600, 400)
        self.setup_ui(site, command, output)
        
    def setup_ui(self, site, command, output):
        layout = QVBoxLayout(self)
        
        # Header information
        header_layout = QHBoxLayout()
        site_label = QLabel(f"Site: {site}")
        site_label.setStyleSheet("font-weight: bold;")
        command_label = QLabel(f"Command: {command}")
        command_label.setStyleSheet("font-weight: bold;")
        header_layout.addWidget(site_label)
        header_layout.addWidget(command_label)
        layout.addLayout(header_layout)
        
        # Output text area
        self.output_text = QTextEdit()
        self.output_text.setReadOnly(True)
        self.output_text.setPlainText(output)
        self.output_text.setStyleSheet("""
            QTextEdit {
                background-color: #f8f9fa;
                border: 1px solid #dee2e6;
                border-radius: 4px;
                padding: 8px;
                font-family: 'Courier New', monospace;
            }
        """)
        layout.addWidget(self.output_text)
        
        # Close button
        close_button = QPushButton("Close")
        close_button.clicked.connect(self.accept)
        close_button.setStyleSheet("""
            QPushButton {
                padding: 8px 15px;
                background-color: #4CAF50;
                color: white;
                border: none;
                border-radius: 4px;
                min-width: 100px;
            }
            QPushButton:hover {
                background-color: #45a049;
            }
        """)
        layout.addWidget(close_button, alignment=Qt.AlignRight)

class BackupWorker(QThread):
    status_update = Signal(str, str, str, str)  # site, command, status, output
    error_occurred = Signal(str)
    finished = Signal()

    def __init__(self, device_info, commands):
        super().__init__()
        self.device_info = device_info
        self.commands = commands

    def run(self):
        try:
            # Create device connection parameters
            device = {
                'device_type': self.device_info['device_type'],
                'host': self.device_info['ip'],
                'username': self.device_info['username'],
                'password': self.device_info['password'],
            }
            
            # Connect to device
            with ConnectHandler(**device) as conn:
                # Get hostname
                hostname = conn.find_prompt().strip('#>')
                
                # Create log directory if it doesn't exist
                log_dir = 'log'
                if not os.path.exists(log_dir):
                    os.makedirs(log_dir)
                
                # Create log filename with pattern
                timestamp = datetime.now().strftime('%Y-%m-%d_%H%M%S')
                log_filename = f"{hostname}-{self.device_info['ip']}_{timestamp}.log"
                log_path = os.path.join(log_dir, log_filename)
                
                # Open log file
                with open(log_path, 'w', encoding='utf-8') as log_file:
                    # Write header
                    log_file.write(f"Device: {hostname} ({self.device_info['ip']})\n")
                    log_file.write(f"Date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
                    log_file.write("-" * 50 + "\n\n")
                    
                    for command in self.commands:
                        try:
                            output = conn.send_command(command)
                            
                            # Write to log file
                            log_file.write(f"Command: {command}\n")
                            log_file.write("-" * 30 + "\n")
                            log_file.write(output)
                            log_file.write("\n\n" + "=" * 50 + "\n\n")
                            
                            # Emit signal for GUI update with status
                            self.status_update.emit(
                                self.device_info['site'],
                                command,
                                "Success",  # Status
                                output
                            )
                        except Exception as e:
                            error_msg = f"Error executing {command}: {str(e)}"
                            log_file.write(f"ERROR: {error_msg}\n\n")
                            self.error_occurred.emit(error_msg)
                            self.status_update.emit(
                                self.device_info['site'],
                                command,
                                "Failed",  # Status
                                error_msg
                            )
                        
        except Exception as e:
            self.error_occurred.emit(f"Connection error: {str(e)}")
        finally:
            self.finished.emit()

class BackupConfigurations(QWidget):
    def __init__(self):
        super().__init__()
        self.excel_data = None
        self.commands_data = None
        self.load_commands()
        self.setup_ui()
        
    def setup_ui(self):
        layout = QVBoxLayout(self)
        
        # File Selection Section
        file_layout = QHBoxLayout()
        self.file_path_label = QLabel("No file selected")
        self.file_path_label.setStyleSheet("""
            QLabel {
                padding: 5px;
                background-color: #f0f0f0;
                border: 1px solid #ccc;
                border-radius: 3px;
            }
        """)
        browse_button = QPushButton("Browse CSV File")
        browse_button.clicked.connect(self.browse_file)
        
        # Add download template button
        download_template_button = QPushButton("Download Template")
        download_template_button.clicked.connect(self.download_template)
        download_template_button.setStyleSheet("""
            QPushButton {
                background-color: #2196F3;
            }
            QPushButton:hover {
                background-color: #1976D2;
            }
        """)
        
        file_layout.addWidget(self.file_path_label)
        file_layout.addWidget(browse_button)
        file_layout.addWidget(download_template_button)
        layout.addLayout(file_layout)
        
        # Site Selection Section
        site_layout = QHBoxLayout()
        site_layout.addWidget(QLabel("Select Site:"))
        self.site_combo = QComboBox()
        self.site_combo.setEnabled(False)
        site_layout.addWidget(self.site_combo)
        layout.addLayout(site_layout)
        
        # Credentials Section
        cred_layout = QHBoxLayout()
        cred_layout.addWidget(QLabel("Username:"))
        self.username_input = QLineEdit()
        self.username_input.setText("sdaadmin")  # Set default username
        cred_layout.addWidget(self.username_input)
        cred_layout.addWidget(QLabel("Password:"))
        self.password_input = QLineEdit()
        self.password_input.setEchoMode(QLineEdit.Password)
        self.password_input.setText("C!sc0123")  # Set default password
        cred_layout.addWidget(self.password_input)
        layout.addLayout(cred_layout)
        
        # Commands Section
        commands_group = QGroupBox("Commands")
        commands_layout = QVBoxLayout()
        
        # Scroll area for commands
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll_content = QWidget()
        self.commands_layout = QVBoxLayout(scroll_content)
        
        # Add command button
        add_command_button = QPushButton("Add Command")
        add_command_button.clicked.connect(self.add_command)
        commands_layout.addWidget(add_command_button)
        
        # Add commands to scroll area
        self.update_commands_list()
        
        scroll.setWidget(scroll_content)
        commands_layout.addWidget(scroll)
        commands_group.setLayout(commands_layout)
        layout.addWidget(commands_group)
        
        # Submit Button
        self.submit_button = QPushButton("Submit")
        self.submit_button.setEnabled(False)
        self.submit_button.clicked.connect(self.start_backup)
        layout.addWidget(self.submit_button)
        
        # Progress Bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)
        
        # Results Table
        self.results_table = QTableWidget()
        self.results_table.setColumnCount(4)
        self.results_table.setHorizontalHeaderLabels(["Site", "Command", "Status", "Output"])
        self.results_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        layout.addWidget(self.results_table)
        
        # Set styles
        self.setStyleSheet("""
            QPushButton {
                padding: 8px 15px;
                background-color: #4CAF50;
                color: white;
                border: none;
                border-radius: 4px;
                min-width: 100px;
            }
            QPushButton:hover {
                background-color: #45a049;
            }
            QPushButton:disabled {
                background-color: #cccccc;
            }
            QLineEdit, QComboBox {
                padding: 5px;
                border: 1px solid #ccc;
                border-radius: 3px;
            }
            QTableWidget {
                border: 1px solid #ccc;
                border-radius: 3px;
            }
            QGroupBox {
                border: 1px solid #ccc;
                border-radius: 5px;
                margin-top: 10px;
                padding-top: 15px;
            }
            QGroupBox::title {
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 5px;
            }
        """)
    
    def load_commands(self):
        commands_file = 'commands.csv'
        if os.path.exists(commands_file):
            self.commands_data = pd.read_csv(commands_file)
        else:
            self.commands_data = pd.DataFrame(columns=['Command', 'Brand', 'Type'])
            self.commands_data.to_csv(commands_file, index=False)
    
    def save_commands(self):
        self.commands_data.to_csv('commands.csv', index=False)
    
    def update_commands_list(self):
        # Clear existing commands
        while self.commands_layout.count():
            item = self.commands_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        
        # Add commands from DataFrame
        for index, row in self.commands_data.iterrows():
            command_layout = QHBoxLayout()
            
            # Create checkbox
            checkbox = QCheckBox(f"{row['Command']} ({row['Brand']} - {row['Type']})")
            command_layout.addWidget(checkbox)
            
            # Create Edit button
            edit_button = QPushButton("Edit")
            edit_button.setStyleSheet("""
                QPushButton {
                    background-color: #2196F3;
                    color: white;
                    padding: 5px 10px;
                    border-radius: 3px;
                }
                QPushButton:hover {
                    background-color: #1976D2;
                }
            """)
            edit_button.clicked.connect(lambda checked, idx=index: self.edit_command(idx))
            command_layout.addWidget(edit_button)
            
            # Create Delete button
            delete_button = QPushButton("Delete")
            delete_button.setStyleSheet("""
                QPushButton {
                    background-color: #f44336;
                    color: white;
                    padding: 5px 10px;
                    border-radius: 3px;
                }
                QPushButton:hover {
                    background-color: #d32f2f;
                }
            """)
            delete_button.clicked.connect(lambda checked, idx=index: self.delete_command(idx))
            command_layout.addWidget(delete_button)
            
            # Add the command layout to the main layout
            self.commands_layout.addLayout(command_layout)
    
    def edit_command(self, index):
        command_data = self.commands_data.iloc[index]
        dialog = CommandDialog(self)
        
        # Set current values
        dialog.command_input.setText(command_data['Command'])
        dialog.brand_combo.setCurrentText(command_data['Brand'])
        dialog.type_input.setText(command_data['Type'])
        
        if dialog.exec_():
            # Update command data
            self.commands_data.at[index, 'Command'] = dialog.command_input.text()
            self.commands_data.at[index, 'Brand'] = dialog.brand_combo.currentText()
            self.commands_data.at[index, 'Type'] = dialog.type_input.text()
            
            # Save and update UI
            self.save_commands()
            self.update_commands_list()
    
    def delete_command(self, index):
        reply = QMessageBox.question(
            self,
            'Confirm Delete',
            'Are you sure you want to delete this command?',
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No
        )
        
        if reply == QMessageBox.Yes:
            # Remove command from DataFrame
            self.commands_data = self.commands_data.drop(index).reset_index(drop=True)
            
            # Save and update UI
            self.save_commands()
            self.update_commands_list()
    
    def add_command(self):
        dialog = CommandDialog(self)
        if dialog.exec_():
            new_command = {
                'Command': dialog.command_input.text(),
                'Brand': dialog.brand_combo.currentText(),
                'Type': dialog.type_input.text()
            }
            self.commands_data = pd.concat([self.commands_data, pd.DataFrame([new_command])], ignore_index=True)
            self.save_commands()
            self.update_commands_list()
    
    def browse_file(self):
        file_name, _ = QFileDialog.getOpenFileName(
            self,
            "Select CSV File",
            "",
            "CSV Files (*.csv);;All Files (*)"
        )
        
        if file_name:
            try:
                self.excel_data = pd.read_csv(file_name)
                self.file_path_label.setText(os.path.basename(file_name))
                self.update_site_combo()
                self.submit_button.setEnabled(True)
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to read CSV file: {str(e)}")
    
    def update_site_combo(self):
        if self.excel_data is not None:
            self.site_combo.clear()
            sites = self.excel_data['Site'].unique()
            self.site_combo.addItems(sites)
            self.site_combo.setEnabled(True)
    
    def get_selected_commands(self):
        selected_commands = []
        for i in range(self.commands_layout.count()):
            layout_item = self.commands_layout.itemAt(i)
            if layout_item and layout_item.layout():
                checkbox = layout_item.layout().itemAt(0).widget()
                if isinstance(checkbox, QCheckBox) and checkbox.isChecked():
                    command_text = checkbox.text().split(' (')[0]
                    selected_commands.append(command_text)
        return selected_commands
    
    def start_backup(self):
        if not self.validate_inputs():
            return
            
        selected_site = self.site_combo.currentText()
        site_data = self.excel_data[self.excel_data['Site'] == selected_site].iloc[0]
        selected_commands = self.get_selected_commands()
        
        if not selected_commands:
            QMessageBox.warning(self, "Warning", "Please select at least one command.")
            return
        
        # Clear previous results
        self.results_table.setRowCount(0)
        
        # Show progress bar
        self.progress_bar.setVisible(True)
        self.progress_bar.setMaximum(len(selected_commands))
        self.progress_bar.setValue(0)
        
        # Disable submit button
        self.submit_button.setEnabled(False)
        
        # Create device info
        device_info = {
            'site': selected_site,
            'ip': site_data['IP_Address'],
            'username': self.username_input.text(),
            'password': self.password_input.text(),
            'device_type': site_data.get('Device_Type', 'cisco_ios')  # Default to cisco_ios
        }
        
        # Start backup process
        self.worker = BackupWorker(device_info, selected_commands)
        self.worker.status_update.connect(self.update_status)
        self.worker.error_occurred.connect(self.show_error)
        self.worker.finished.connect(self.backup_finished)
        self.worker.start()
    
    def validate_inputs(self):
        if self.excel_data is None:
            QMessageBox.warning(self, "Warning", "Please select a CSV file first.")
            return False
            
        if not self.username_input.text() or not self.password_input.text():
            QMessageBox.warning(self, "Warning", "Please enter both username and password.")
            return False
            
        return True
    
    def update_status(self, site, command, status, output):
        row = self.results_table.rowCount()
        self.results_table.insertRow(row)
        
        self.results_table.setItem(row, 0, QTableWidgetItem(site))
        self.results_table.setItem(row, 1, QTableWidgetItem(command))
        
        # Add status with color
        status_item = QTableWidgetItem(status)
        if status == "Success":
            status_item.setForeground(Qt.green)
        else:
            status_item.setForeground(Qt.red)
        self.results_table.setItem(row, 2, status_item)
        
        # Create a button to show output
        output_button = QPushButton("View Output")
        output_button.setStyleSheet("""
            QPushButton {
                background-color: #2196F3;
                color: white;
                padding: 5px 10px;
                border-radius: 3px;
            }
            QPushButton:hover {
                background-color: #1976D2;
            }
        """)
        output_button.clicked.connect(lambda: self.show_output_dialog(site, command, output))
        
        # Create a widget to hold the button
        button_widget = QWidget()
        button_layout = QHBoxLayout(button_widget)
        button_layout.addWidget(output_button)
        button_layout.setContentsMargins(0, 0, 0, 0)
        
        self.results_table.setCellWidget(row, 3, button_widget)
    
    def show_output_dialog(self, site, command, output):
        dialog = OutputDialog(site, command, output, self)
        dialog.exec_()
    
    def show_error(self, error_message):
        QMessageBox.warning(self, "Error", error_message)
    
    def backup_finished(self):
        self.progress_bar.setVisible(False)
        self.submit_button.setEnabled(True)
    
    def download_template(self):
        try:
            # Get the template file path
            template_path = os.path.join('templates', 'device_list_template.csv')
            
            # Ask user where to save the file
            save_path, _ = QFileDialog.getSaveFileName(
                self,
                "Save Template File",
                "device_list_template.csv",
                "CSV Files (*.csv);;All Files (*)"
            )
            
            if save_path:
                # Copy template to selected location
                shutil.copy2(template_path, save_path)
                QMessageBox.information(
                    self,
                    "Success",
                    f"Template file has been saved to:\n{save_path}"
                )
        except Exception as e:
            QMessageBox.critical(
                self,
                "Error",
                f"Failed to download template: {str(e)}"
            )

def get_widget():
    return BackupConfigurations() 