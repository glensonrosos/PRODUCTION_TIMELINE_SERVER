const Season = require('../models/Season');
const SeasonSnapshot = require('../models/SeasonSnapshot');
const logActivity = require('../utils/logActivity');
const { updateSeasonAttention } = require('../utils/taskProgression');
const ExcelJS = require('exceljs');
const moment = require('moment');

/**
 * @route   PUT /api/seasons/:id/status
 * @desc    Update a season's status
 * @access  Planner or Admin
 */
const updateSeasonStatus = async (req, res) => {
  const { id: seasonId } = req.params;
  const { status: newStatus } = req.body;
  const userId = req.user.id;

  const validStatuses = ['Open', 'On-Hold', 'Closed', 'Canceled'];
  if (!validStatuses.includes(newStatus)) {
    return res.status(400).json({ message: `Invalid status: ${newStatus}` });
  }

  try {
    const season = await Season.findById(seasonId);
    if (!season) {
      return res.status(404).json({ message: 'Season not found' });
    }

    const oldStatus = season.status;
    if (oldStatus === newStatus) {
      return res.status(200).json({ message: 'Status is already set to the requested value.', season });
    }

    season.status = newStatus;

    if (newStatus === 'Open') {
      // When reopening, re-evaluate the requireAttention field
      const snapshot = await SeasonSnapshot.findOne({ seasonId: season._id });
      if (snapshot) {
        await updateSeasonAttention(season, snapshot.tasks);
      }
    } else {
      // For 'On-Hold', 'Closed', 'Canceled', clear requireAttention
      season.requireAttention = [];
    }

    await season.save();

    // Log the status change
    await logActivity({
      user: { _id: userId },
      seasonId: seasonId,
      action: 'UPDATE_STATUS',
      details: `Season status updated from "${oldStatus}" to "${newStatus}".`
    });

    const populatedSeason = await Season.findById(seasonId).populate('buyer', 'name');
    res.json(populatedSeason);

  } catch (error) {
    console.error('Error updating season status:', error);
    res.status(500).json({ message: 'Server error while updating status.' });
  }
};

const exportSeasonToExcel = async (req, res) => {
  try {
    const { id } = req.params;
    const season = await Season.findById(id).populate('buyer', 'name');
    const snapshot = await SeasonSnapshot.findOne({ seasonId: id });

    if (!season || !snapshot) {
      return res.status(404).json({ message: 'Season not found.' });
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet(`${season.name} - Details`);

    // --- Header Section ---
    worksheet.mergeCells('A1:D1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = 'Production Timeline Report';
    titleCell.font = { name: 'Calibri', size: 18, bold: true };
    titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
    worksheet.getRow(1).height = 30;

    // Season Details
    worksheet.mergeCells('A2:B2');
    worksheet.getCell('A2').value = 'Season Name:';
    worksheet.getCell('A2').font = { bold: true };
    worksheet.mergeCells('C2:D2');
    worksheet.getCell('C2').value = season.name;

    worksheet.mergeCells('A3:B3');
    worksheet.getCell('A3').value = 'Buyer:';
    worksheet.getCell('A3').font = { bold: true };
    worksheet.mergeCells('C3:D3');
    worksheet.getCell('C3').value = season.buyer.name;

    worksheet.mergeCells('A4:B4');
    worksheet.getCell('A4').value = 'Status:';
    worksheet.getCell('A4').font = { bold: true };
    worksheet.mergeCells('C4:D4');
    worksheet.getCell('C4').value = season.status;

    worksheet.mergeCells('A5:B5');
    worksheet.getCell('A5').value = 'Date Created:';
    worksheet.getCell('A5').font = { bold: true };
    worksheet.mergeCells('C5:D5');
    worksheet.getCell('C5').value = moment(season.createdAt).format('DD-MMM-YYYY');

    worksheet.mergeCells('A6:B6');
    worksheet.getCell('A6').value = 'Export Date:';
    worksheet.getCell('A6').font = { bold: true };
    worksheet.mergeCells('C6:D6');
    worksheet.getCell('C6').value = moment().format('DD-MMM-YYYY HH:mm');
    
    worksheet.addRow([]); // Spacer row

    // --- Task Table Headers ---
    const headerRow = worksheet.addRow([
      'Order',
      'Task Name',
      'Responsible Dept.',
      'Lead Time',
      'Preceding Tasks',
      'Status',
      'Start Date',
      'End Date',
      'Actual Completion',
      'Date Spent',
      'Attachment',
      'Remarks',
    ]);

    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4F81BD' },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      };
    });
    headerRow.height = 25;

    // --- Task Data ---
    snapshot.tasks.forEach(task => {
      let dateSpentFormatted = 'N/A';
      // Calculate difference against the planned end date, ignoring time of day.
      if (task.actualCompletion && task.computedDates.end) {
        const actual = moment(task.actualCompletion).startOf('day');
        const planned = moment(task.computedDates.end).startOf('day');
        const diff = actual.diff(planned, 'days');

        if (diff < 0) {
          const daysSaved = Math.abs(diff);
          dateSpentFormatted = `Saves ${daysSaved} day${daysSaved > 1 ? 's' : ''}`;
        } else if (diff > 0) {
          dateSpentFormatted = `Over ${diff} day${diff > 1 ? 's' : ''}`;
        } else {
          dateSpentFormatted = 'On Time';
        }
      }

      const row = worksheet.addRow([
        task.order,
        task.name,
        task.responsible.join(', '),
        task.leadTime,
        task.precedingTasks.join(', '),
        task.status,
        task.computedDates.start ? moment(task.computedDates.start).format('DD-MMM-YY') : 'N/A',
        task.computedDates.end ? moment(task.computedDates.end).format('DD-MMM-YY') : 'N/A',
        task.actualCompletion ? moment(task.actualCompletion).format('DD-MMM-YY') : 'N/A',
        dateSpentFormatted,
        task.attachments && task.attachments.length > 0 ? 'Yes' : 'No',
        task.remarks || '',
      ]);
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    // --- Column Widths ---
    worksheet.getColumn('A').width = 10;
    worksheet.getColumn('B').width = 40;
    worksheet.getColumn('C').width = 20;
    worksheet.getColumn('D').width = 15; // Lead Time
    worksheet.getColumn('E').width = 20; // Preceding Tasks
    worksheet.getColumn('F').width = 15; // Status
    worksheet.getColumn('G').width = 15; // Start Date
    worksheet.getColumn('H').width = 15; // End Date
    worksheet.getColumn('I').width = 20; // Actual Completion
    worksheet.getColumn('J').width = 15; // Date Spent
    worksheet.getColumn('K').width = 15; // Attachment
    worksheet.getColumn('L').width = 50; // Remarks

    // --- Send to Client ---
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${season.name.replace(/\s+/g, '_')}_${moment().format('YYYYMMDD')}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('Failed to export season to Excel:', error);
    res.status(500).json({ message: 'Server error while exporting data.' });
  }
};

module.exports = {
  updateSeasonStatus,
  exportSeasonToExcel,
};
