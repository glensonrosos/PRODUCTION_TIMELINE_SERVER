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

    // Helper function to calculate the reference timeline
    const calculateReferenceTimeline = (tasks, seasonCreationDate) => {
      const timeline = new Map();
      if (!tasks || tasks.length === 0) return timeline;

      const tasksByOrder = new Map(tasks.map(task => [task.order, task]));
      const sortedTasksForCalc = [...tasks].sort((a, b) => {
        if (a.order.length < b.order.length) return -1;
        if (a.order.length > b.order.length) return 1;
        return a.order.localeCompare(b.order);
      });

      let tasksToProcess = sortedTasksForCalc.length;
      let iterations = 0;
      const MAX_ITERATIONS = tasksToProcess + 5;

      while (tasksToProcess > 0 && iterations < MAX_ITERATIONS) {
        let processedInThisIteration = 0;
        sortedTasksForCalc.forEach(task => {
          if (timeline.has(task._id.toString())) return;

          let canCalculate = true;
          let maxPrecedingEndDate = moment(seasonCreationDate);

          if (task.precedingTasks && task.precedingTasks.length > 0) {
            for (const precedingOrder of task.precedingTasks) {
              const precedingTask = tasksByOrder.get(precedingOrder);
              if (precedingTask && timeline.has(precedingTask._id.toString())) {
                const precedingEndDate = timeline.get(precedingTask._id.toString()).end;
                if (moment(precedingEndDate).isAfter(maxPrecedingEndDate)) {
                  maxPrecedingEndDate = moment(precedingEndDate);
                }
              } else {
                canCalculate = false;
                break;
              }
            }
          }

          if (canCalculate) {
            const startDate = maxPrecedingEndDate;
            const endDate = moment(startDate).add(task.leadTime, 'days');
            timeline.set(task._id.toString(), { start: startDate.toDate(), end: endDate.toDate() });
            processedInThisIteration++;
          }
        });

        tasksToProcess -= processedInThisIteration;
        iterations++;
        if (processedInThisIteration === 0 && tasksToProcess > 0) {
          console.error("Could not resolve all task dependencies for reference timeline in export.");
          break;
        }
      }
      return timeline;
    };

    const referenceTimeline = calculateReferenceTimeline(snapshot.tasks, season.createdAt);

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
      'Timeline Reference',
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
    const sortedTasks = snapshot.tasks.sort((a, b) => {
      const orderA = a.order;
      const orderB = b.order;
      if (orderA.length < orderB.length) return -1;
      if (orderA.length > orderB.length) return 1;
      return orderA.localeCompare(orderB);
    });

    sortedTasks.forEach(task => {
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

      const timelineInfo = referenceTimeline.get(task._id.toString());
      let timelineReferenceText = '...';
      if (timelineInfo && timelineInfo.start && timelineInfo.end) {
        const start = moment(timelineInfo.start).format('DD-MMM-YY');
        const end = moment(timelineInfo.end).format('DD-MMM-YY');
        timelineReferenceText = `${start} - ${end}`;
      }

      const row = worksheet.addRow([
        task.order,
        task.name,
        timelineReferenceText,
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
    worksheet.getColumn('C').width = 25; // Timeline Reference
    worksheet.getColumn('D').width = 20; // Responsible Dept.
    worksheet.getColumn('E').width = 15; // Lead Time
    worksheet.getColumn('F').width = 20; // Preceding Tasks
    worksheet.getColumn('G').width = 15; // Status
    worksheet.getColumn('H').width = 15; // Start Date
    worksheet.getColumn('I').width = 15; // End Date
    worksheet.getColumn('J').width = 20; // Actual Completion
    worksheet.getColumn('K').width = 15; // Date Spent
    worksheet.getColumn('L').width = 15; // Attachment
    worksheet.getColumn('M').width = 50; // Remarks

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
