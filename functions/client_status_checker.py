import os
import pandas as pd
import paramiko
from PySide6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QPushButton,
                             QLabel, QLineEdit, QComboBox, QTableWidget,
                             QTableWidgetItem, QFileDialog, QMessageBox,
                             QHeaderView, QProgressBar)
from PySide6.QtCore import Qt, QThread, Signal

class SSHWorker(QThread):
    status_update = Signal(str, str, str)  # site, mac, status
    error_occurred = Signal(str)
    finished = Signal()

    def __init__(self, host, username, password, mac_address):
        super().__init__()
        self.host = host
        self.username = username
        self.password = password
        self.mac_address = mac_address

    def run(self):
        try:
            # Create SSH client
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            
            # Connect to the device
            ssh.connect(self.host, username=self.username, password=self.password)
            
            # Run command to check client status
            command = f"show client {self.mac_address}"
            stdin, stdout, stderr = ssh.exec_command(command)
            
            # Read the output
            output = stdout.read().decode()
            error = stderr.read().decode()
            
            if error:
                self.error_occurred.emit(f"Error checking status: {error}")
            else:
                # Parse the output to determine status
                status = "Connected" if "Associated" in output else "Disconnected"
                self.status_update.emit(self.host, self.mac_address, status)
            
            ssh.close()
            
        except Exception as e:
            self.error_occurred.emit(f"Connection error: {str(e)}")
        finally:
            self.finished.emit()

class ClientStatusChecker(QWidget):
    def __init__(self):
        super().__init__()
        self.excel_data = None
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
        browse_button = QPushButton("Browse Excel File")
        browse_button.clicked.connect(self.browse_file)
        file_layout.addWidget(self.file_path_label)
        file_layout.addWidget(browse_button)
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
        cred_layout.addWidget(self.username_input)
        cred_layout.addWidget(QLabel("Password:"))
        self.password_input = QLineEdit()
        self.password_input.setEchoMode(QLineEdit.Password)
        cred_layout.addWidget(self.password_input)
        layout.addLayout(cred_layout)
        
        # Check Status Button
        self.check_button = QPushButton("Check Status")
        self.check_button.setEnabled(False)
        self.check_button.clicked.connect(self.check_status)
        layout.addWidget(self.check_button)
        
        # Progress Bar
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        layout.addWidget(self.progress_bar)
        
        # Results Table
        self.results_table = QTableWidget()
        self.results_table.setColumnCount(3)
        self.results_table.setHorizontalHeaderLabels(["Site", "MAC Address", "Status"])
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
        """)
        
    def browse_file(self):
        file_name, _ = QFileDialog.getOpenFileName(
            self,
            "Select Excel File",
            "",
            "Excel Files (*.xlsx *.xls);;All Files (*)"
        )
        
        if file_name:
            try:
                self.excel_data = pd.read_excel(file_name)
                self.file_path_label.setText(os.path.basename(file_name))
                self.update_site_combo()
                self.check_button.setEnabled(True)
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to read Excel file: {str(e)}")
    
    def update_site_combo(self):
        if self.excel_data is not None:
            self.site_combo.clear()
            sites = self.excel_data['Site'].unique()
            self.site_combo.addItems(sites)
            self.site_combo.setEnabled(True)
    
    def check_status(self):
        if not self.validate_inputs():
            return
            
        selected_site = self.site_combo.currentText()
        site_data = self.excel_data[self.excel_data['Site'] == selected_site]
        
        # Clear previous results
        self.results_table.setRowCount(0)
        
        # Show progress bar
        self.progress_bar.setVisible(True)
        self.progress_bar.setMaximum(len(site_data))
        self.progress_bar.setValue(0)
        
        # Disable check button
        self.check_button.setEnabled(False)
        
        # Process each client
        for index, row in site_data.iterrows():
            worker = SSHWorker(
                row['IP_Address'],
                self.username_input.text(),
                self.password_input.text(),
                row['MAC_Address']
            )
            
            worker.status_update.connect(self.update_status)
            worker.error_occurred.connect(self.show_error)
            worker.finished.connect(self.update_progress)
            
            worker.start()
    
    def validate_inputs(self):
        if self.excel_data is None:
            QMessageBox.warning(self, "Warning", "Please select an Excel file first.")
            return False
            
        if not self.username_input.text() or not self.password_input.text():
            QMessageBox.warning(self, "Warning", "Please enter both username and password.")
            return False
            
        return True
    
    def update_status(self, site, mac, status):
        row = self.results_table.rowCount()
        self.results_table.insertRow(row)
        
        self.results_table.setItem(row, 0, QTableWidgetItem(site))
        self.results_table.setItem(row, 1, QTableWidgetItem(mac))
        status_item = QTableWidgetItem(status)
        status_item.setForeground(Qt.green if status == "Connected" else Qt.red)
        self.results_table.setItem(row, 2, status_item)
    
    def show_error(self, error_message):
        QMessageBox.warning(self, "Error", error_message)
    
    def update_progress(self):
        current = self.progress_bar.value() + 1
        self.progress_bar.setValue(current)
        
        if current >= self.progress_bar.maximum():
            self.progress_bar.setVisible(False)
            self.check_button.setEnabled(True)

def get_widget():
    return ClientStatusChecker() 